const express = require('express');
const router = express.Router();
const { Report, Room, RoomParticipant, User } = require('../models');

// POST /report - Report a user in a room
router.post('/', async (req, res) => {
  try {
    const userRequestingToBlockId = req.user.id; // Extracted from JWT token via authMiddleware
    const { roomId, userToBlockId } = req.body;

    // Validate request body
    if (!roomId || !userToBlockId) {
      return res.status(400).json({ error: 'roomId and userToBlockId are required' });
    }

    // Validate that both users are in the room
    const reportingUserParticipant = await RoomParticipant.findOne({
      where: { roomId, userId: userRequestingToBlockId, isActive: true }
    });

    if (!reportingUserParticipant) {
      return res.status(404).json({ error: 'You are not in this room' });
    }

    const targetUserParticipant = await RoomParticipant.findOne({
      where: { roomId, userId: userToBlockId, isActive: true }
    });

    if (!targetUserParticipant) {
      return res.status(404).json({ error: 'User to report is not in this room' });
    }

    // Prevent self-reporting
    if (userRequestingToBlockId.toString() === userToBlockId.toString()) {
      return res.status(400).json({ error: 'You cannot report yourself' });
    }

    // Find or create report entry
    let report = await Report.findOne({
      where: { roomId, userToBlockId }
    });

    if (!report) {
      // Create new report entry
      report = await Report.create({
        roomId,
        userToBlockId,
        reportedBy: [],
        reportCount: 0
      });
    }

    // Check if user has already reported this user in this room
    const reportedByArray = report.reportedBy || [];
    if (reportedByArray.includes(userRequestingToBlockId.toString())) {
      return res.status(400).json({ error: 'You have already reported this user' });
    }

    // Add reporting user to reportedBy array
    reportedByArray.push(userRequestingToBlockId.toString());
    const newReportCount = reportedByArray.length;

    // Update report entry
    await report.update({
      reportedBy: reportedByArray,
      reportCount: newReportCount
    });

    // Check if reportCount reached 3
    if (newReportCount >= 3) {
      // Get room details
      const room = await Room.findByPk(roomId);
      if (!room) {
        return res.status(404).json({ error: 'Room not found' });
      }

      // Get user details for the message
      const bannedUser = await User.findByPk(userToBlockId);
      const userName = bannedUser ? bannedUser.name : 'User';

      // Get socket.io instance from app.locals (set in server.js)
      const io = req.app.locals.io;
      
      // Store socketId before updating (since we'll set it to null)
      const userSocketId = targetUserParticipant.socketId;

      // Ban the user from the room (set isActive to false)
      await RoomParticipant.update(
        { isActive: false, socketId: null },
        { where: { roomId, userId: userToBlockId } }
      );

      if (io) {
        // If user is connected via socket, kick them
        if (userSocketId) {
          const userSocket = io.sockets.sockets.get(userSocketId);
          if (userSocket) {
            userSocket.leave(room.code);
            userSocket.emit('user_banned', {
              message: `You have been banned from this room due to multiple reports`,
              roomId: roomId
            });
          }
        }

        // Broadcast to room that user was banned
        io.to(room.code).emit('user_banned_from_room', {
          message: `${userName} has been banned from the room for multiple reports`,
          bannedUserId: userToBlockId,
          roomId: roomId
        });

        // Update room participants list
        const activeParticipants = await RoomParticipant.findAll({
          where: { roomId, isActive: true },
          include: [{ model: User, as: 'user', attributes: ['id', 'name', 'avatar', 'coins'] }]
        });

        io.to(room.code).emit('room_participants', {
          participants: activeParticipants.map(p => ({
            id: p.userId,
            name: p.user ? p.user.name : 'Guest',
            avatar: p.user ? p.user.avatar : null,
            coins: p.user ? p.user.coins : 0,
            score: p.score,
            team: p.team,
            isDrawer: p.isDrawer,
            socketId: p.socketId,
            hasPaidEntry: p.hasPaidEntry
          }))
        });
      }

      console.log(`🚫 User ${userToBlockId} (${userName}) banned from room ${roomId} after ${newReportCount} reports`);

      return res.json({
        success: true,
        message: 'User reported and banned from room',
        reportCount: newReportCount,
        banned: true
      });
    }

    // Report added but count not reached 3 yet
    return res.json({
      success: true,
      message: 'User reported successfully',
      reportCount: newReportCount,
      banned: false
    });

  } catch (err) {
    console.error('Report error:', err);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

module.exports = router;

