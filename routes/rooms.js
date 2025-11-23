const express = require("express");
const router = express.Router();
const {
  Room,
  RoomParticipant,
  User,
  Theme,
  Word,
  sequelize,
} = require("../models");
const { Op } = require("sequelize");

// Generate unique room code
function generateRoomCode() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

// Assign team randomly for team_vs_team mode
function assignTeamRandomly(existingParticipants) {
  const teamACount = existingParticipants.filter((p) => p.team === "A").length;
  const teamBCount = existingParticipants.filter((p) => p.team === "B").length;
  return teamACount <= teamBCount ? "A" : "B";
}

// CREATE ROOM (Simplified - only name required, settings in lobby) - Protected by global middleware
router.post("/create", async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: "room_name_required" });
    }

    const code = generateRoomCode();

    const room = await Room.create({
      name: name.trim(),
      code,
      ownerId: req.user.id,
      gameMode: "1v1", // Default to 1v1
      status: "lobby", // Start in lobby
      isPublic: false, // Default to private
      voiceEnabled: false, // Default voice off
      entryPoints: 250, // Default entry
      targetPoints: 100, // Default target
      maxPlayers: 15,
    });

    console.log(
      `🏠 Room created: ${room.id} (${room.name}) by ${req.user.name} (${req.user.id}) - Code: ${room.code}`,
    );

    // Owner joins automatically (no entry fee yet)
    await RoomParticipant.create({
      roomId: room.id,
      userId: req.user.id,
      isDrawer: false,
      hasPaidEntry: false, // Will pay when game starts
    });

    res.json({
      success: true,
      room: {
        id: room.id,
        code: room.code, // Always show code for sharing
        name: room.name,
        gameMode: room.gameMode,
        status: room.status,
        isPublic: room.isPublic,
        voiceEnabled: room.voiceEnabled,
        entryPoints: room.entryPoints,
        targetPoints: room.targetPoints,
        maxPlayers: room.maxPlayers,
        participantCount: 1,
        ownerId: room.ownerId,
      },
    });
  } catch (err) {
    console.error("Create room error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

// UPDATE LOBBY SETTINGS (Only owner can update) - Protected by global middleware
router.post("/:roomId/update-settings", async (req, res) => {
  try {
    const room = await Room.findByPk(req.params.roomId);

    if (!room) {
      return res.status(404).json({ error: "room_not_found" });
    }

    // Only owner can update settings
    if (room.ownerId !== req.user.id) {
      console.log(`${room.ownerId} ${room.req.user.id}`);
      return res.status(403).json({ error: "only_owner_can_update" });
    }

    // Can only update in lobby or waiting (before game starts)
    if (room.status !== "lobby" && room.status !== "waiting") {
      return res
        .status(400)
        .json({ error: "cannot_update_after_game_started" });
    }

    const {
      gameMode,
      language,
      script,
      country,
      category,
      entryPoints,
      targetPoints,
      voiceEnabled,
      isPublic,
      maxPlayers,
    } = req.body;

    // Update room settings
    if (gameMode !== undefined) room.gameMode = gameMode;
    if (language !== undefined) room.language = language;
    if (script !== undefined) room.script = script;
    if (country !== undefined) room.country = country;
    if (category !== undefined) {
      room.category = category;
      // Update theme
      const theme = await Theme.findOne({ where: { title: category } });
      room.themeId = theme ? theme.id : null;
    }
    if (entryPoints !== undefined) room.entryPoints = entryPoints;
    if (targetPoints !== undefined) room.targetPoints = targetPoints;
    if (voiceEnabled !== undefined) room.voiceEnabled = voiceEnabled;
    if (isPublic !== undefined) room.isPublic = isPublic;
    if (maxPlayers !== undefined) {
      // Enforce maximum limit of 15 players
      room.maxPlayers = Math.min(Math.max(maxPlayers, 2), 15);
    }

    await room.save();

    console.log(`⚙️  Room ${room.id} settings updated by owner`);

    res.json({
      success: true,
      room: {
        id: room.id,
        code: room.code,
        name: room.name,
        gameMode: room.gameMode,
        language: room.language,
        script: room.script,
        country: room.country,
        category: room.category,
        entryPoints: room.entryPoints,
        targetPoints: room.targetPoints,
        voiceEnabled: room.voiceEnabled,
        isPublic: room.isPublic,
        maxPlayers: room.maxPlayers,
        status: room.status,
      },
    });
  } catch (err) {
    console.error("Update settings error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

// UPDATE TEAM SELECTION (For team_vs_team mode) - Protected by global middleware
router.post("/:roomId/select-team", async (req, res) => {
  try {
    const { team } = req.body; // 'orange' or 'blue'

    if (!team || (team !== "orange" && team !== "blue")) {
      return res.status(400).json({ error: "invalid_team" });
    }

    const room = await Room.findByPk(req.params.roomId);

    if (!room) {
      return res.status(404).json({ error: "room_not_found" });
    }

    // Can only change team in lobby or waiting (before game starts)
    if (room.status !== "lobby" && room.status !== "waiting") {
      return res
        .status(400)
        .json({ error: "cannot_change_team_after_game_started" });
    }

    if (room.gameMode !== "team" && room.gameMode !== "team_vs_team") {
      return res.status(400).json({ error: "not_team_mode" });
    }

    const participant = await RoomParticipant.findOne({
      where: { roomId: room.id, userId: req.user.id },
    });

    if (!participant) {
      return res.status(404).json({ error: "not_in_room" });
    }

    participant.team = team;
    await participant.save();

    console.log(
      `👥 User ${req.user.name} selected team ${team} in room ${room.id}`,
    );

    res.json({
      success: true,
      participant: {
        id: participant.id,
        userId: participant.userId,
        team: participant.team,
      },
    });
  } catch (err) {
    console.error("Select team error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

// JOIN ROOM BY CODE - Protected by global middleware
router.post("/join", async (req, res) => {
  try {
    const { code, team } = req.body;

    if (!code) {
      return res.status(400).json({ error: "code_required" });
    }

    const room = await Room.findOne({ where: { code } });

    if (!room) {
      return res.status(404).json({ error: "room_not_found" });
    }

    // Check if room is full
    const participantCount = await RoomParticipant.count({
      where: { roomId: room.id, isActive: true },
    });

    if (participantCount >= room.maxPlayers) {
      return res.status(400).json({ error: "room_full" });
    }

    // Check if user has enough coins
    const user = await User.findByPk(req.user.id);

    if (!user || user.coins < room.entryPoints) {
      return res.status(400).json({
        error: "insufficient_coins",
        message: `You need ${room.entryPoints} coins to join this room`,
        required: room.entryPoints,
        current: user ? user.coins : 0,
      });
    }

    // Check if user already in room
    let participant = await RoomParticipant.findOne({
      where: { roomId: room.id, userId: req.user.id },
    });

    if (participant) {
      // Reactivate if was inactive
      participant.isActive = true;
      participant.hasPaidEntry = true;
      await participant.save();
    } else {
      // Deduct coins from user
      user.coins -= room.entryPoints;
      await user.save();
      console.log(
        `💰 Deducted ${room.entryPoints} coins from user ${req.user.id}. Remaining: ${user.coins}`,
      );

      // Assign team if team mode (gameMode: 'team' or 'team_vs_team')
      let assignedTeam = null;
      if (room.gameMode === "team" || room.gameMode === "team_vs_team") {
        if (team && (team === "orange" || team === "blue")) {
          assignedTeam = team;
        } else {
          // Auto-assign to balance teams
          const participants = await RoomParticipant.findAll({
            where: { roomId: room.id, isActive: true },
          });
          assignedTeam = assignTeamRandomly(participants);
        }
      }

      participant = await RoomParticipant.create({
        roomId: room.id,
        userId: req.user.id,
        team: assignedTeam,
        isDrawer: false,
        hasPaidEntry: true,
      });
    }

    // Get updated participant count after join
    const updatedParticipantCount = await RoomParticipant.count({
      where: { roomId: room.id, isActive: true },
    });

    res.json({
      success: true,
      room: {
        id: room.id,
        code: room.isPublic ? undefined : room.code, // Only show code for private rooms
        name: room.name,
        roomType: room.roomType,
        language: room.language,
        category: room.category,
        voiceEnabled: room.voiceEnabled,
        status: room.status,
        maxPlayers: room.maxPlayers,
        participantCount: updatedParticipantCount,
      },
      participant: {
        id: participant.id,
        team: participant.team,
        score: participant.score,
      },
    });
  } catch (err) {
    console.error("Join room error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

// PLAY RANDOM - Find and join a matching public room (no room creation) - Protected by global middleware
router.post("/play-random", async (req, res) => {
  try {
    const { language, category, country, voiceEnabled, targetPoints } =
      req.body;

    console.log(
      `🎲 Play Random request from user ${req.user.id}: ${language}, ${category}, ${country}, voice: ${voiceEnabled}, targetPoints: ${targetPoints}`,
    );

    if (
      !language ||
      !category ||
      !country ||
      voiceEnabled === undefined ||
      !targetPoints
    ) {
      return res.status(400).json({
        error: "missing_parameters",
        message:
          "language, category, country, voiceEnabled, and targetPoints are required",
      });
    }

    // Build exact match criteria for public 1v1 rooms only
    const where = {
      isPublic: true,
      status: { [Op.in]: ["lobby", "waiting"] }, // Match both lobby and waiting status
      gameMode: "1v1", // Only match 1v1 rooms for play random
      language: language,
      category: category,
      country: country,
      voiceEnabled: voiceEnabled,
      targetPoints: parseInt(targetPoints), // Match target points
    };

    // Find matching public rooms with available slots
    const rooms = await Room.findAll({
      where,
      include: [
        {
          model: RoomParticipant,
          as: "participants",
          where: { isActive: true },
          required: false,
        },
      ],
    });

    console.log(
      `🔍 Play Random: Found ${rooms.length} matching rooms for user ${req.user.id}`,
    );

    // Filter rooms that aren't full and user isn't already active in them
    const availableRooms = [];
    for (const room of rooms) {
      const participantCount = room.participants ? room.participants.length : 0;
      const isRoomFull = participantCount >= room.maxPlayers;

      // Check if user is already ACTIVE in this room (only active participants matter)
      const userActiveInRoom =
        room.participants &&
        room.participants.some((p) => p.userId === req.user.id && p.isActive);

      if (!isRoomFull && !userActiveInRoom) {
        availableRooms.push(room);
        console.log(
          `✅ Available room found: ${room.id} (${room.name}) - ${participantCount}/${room.maxPlayers} players`,
        );
      } else {
        console.log(
          `❌ Room ${room.id} not available - Full: ${isRoomFull}, UserActiveInRoom: ${userActiveInRoom}`,
        );
      }
    }

    console.log(`🎯 Total available rooms: ${availableRooms.length}`);

    if (availableRooms.length === 0) {
      return res.json({
        success: false,
        matched: false,
        message: "no_matches_found",
        suggestion: "Try with different preferences or create a new room",
      });
    }

    // Sort rooms by participant count (descending) to prioritize rooms with more players
    availableRooms.sort((a, b) => {
      const aCount = a.participants ? a.participants.length : 0;
      const bCount = b.participants ? b.participants.length : 0;
      return bCount - aCount; // Higher participant count first
    });

    // Join the room with the most players (best match)
    const room = availableRooms[0];
    const roomParticipantCount = room.participants
      ? room.participants.length
      : 0;
    console.log(
      `🎯 Selected room ${room.id} (${room.name}) with ${roomParticipantCount} existing players`,
    );

    console.log(
      `🎮 User ${req.user.id} joining room ${room.id} (${room.name})`,
    );

    // Check if user has enough coins
    const user = await User.findByPk(req.user.id);
    console.log(
      `💰 Coin check for play-random: User ${user.name} has ${user.coins} coins, room requires ${room.entryPoints} coins`,
    );

    if (!user || user.coins < room.entryPoints) {
      console.log(
        `❌ Insufficient coins for play-random: ${user.coins} < ${room.entryPoints}`,
      );
      return res.status(400).json({
        error: "insufficient_coins",
        message: `You need ${room.entryPoints} coins to join this room`,
        required: room.entryPoints,
        current: user ? user.coins : 0,
      });
    }

    console.log(`✅ User has enough coins to join via play-random`);

    // Check if user already has a participant record and reactivate it, or create new one
    let participant = await RoomParticipant.findOne({
      where: { roomId: room.id, userId: req.user.id },
    });

    if (participant) {
      // Reactivate existing participant
      participant.isActive = true;
      participant.hasPaidEntry = true;
      await participant.save();
      console.log(
        `🔄 Reactivated existing participant for user ${req.user.id} in room ${room.id}`,
      );
    } else {
      // Deduct coins from user
      user.coins -= room.entryPoints;
      await user.save();
      console.log(
        `💰 Deducted ${room.entryPoints} coins from user ${req.user.id}. Remaining: ${user.coins}`,
      );

      // Create new participant entry
      participant = await RoomParticipant.create({
        roomId: room.id,
        userId: req.user.id,
        isDrawer: false,
        hasPaidEntry: true,
      });
      console.log(
        `✨ Created new participant for user ${req.user.id} in room ${room.id}`,
      );
    }

    // Get updated participant count
    const participantCount = await RoomParticipant.count({
      where: { roomId: room.id, isActive: true },
    });

    res.json({
      success: true,
      matched: true,
      room: {
        id: room.id,
        name: room.name,
        language: room.language,
        category: room.category,
        country: room.country,
        voiceEnabled: room.voiceEnabled,
        status: room.status,
        maxPlayers: room.maxPlayers,
        participantCount,
      },
      participant: {
        id: participant.id,
        score: participant.score,
      },
    });
  } catch (err) {
    console.error("Play random error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

// JOIN ROOM BY ID (for public rooms) - Protected by global middleware
router.post("/join-by-id", async (req, res) => {
  try {
    const { roomId, team } = req.body;

    if (!roomId) {
      return res.status(400).json({ error: "room_id_required" });
    }

    const room = await Room.findByPk(roomId);

    if (!room) {
      return res.status(404).json({ error: "room_not_found" });
    }

    // Check if room is full
    const participantCount = await RoomParticipant.count({
      where: { roomId: room.id, isActive: true },
    });

    if (participantCount >= room.maxPlayers) {
      return res.status(400).json({ error: "room_full" });
    }

    // Check if user has enough coins
    const user = await User.findByPk(req.user.id);
    if (!user || user.coins < room.entryPoints) {
      return res.status(400).json({
        error: "insufficient_coins",
        message: `You need ${room.entryPoints} coins to join this room`,
        required: room.entryPoints,
        current: user ? user.coins : 0,
      });
    }

    // Check if user already in room
    let participant = await RoomParticipant.findOne({
      where: { roomId: room.id, userId: req.user.id },
    });

    if (participant) {
      // Reactivate if was inactive
      participant.isActive = true;
      participant.hasPaidEntry = true;
      await participant.save();
    } else {
      // Deduct coins from user
      user.coins -= room.entryPoints;
      await user.save();
      console.log(
        `💰 Deducted ${room.entryPoints} coins from user ${req.user.id}. Remaining: ${user.coins}`,
      );

      // Assign team if team mode (gameMode: 'team' or 'team_vs_team')
      let assignedTeam = null;
      if (room.gameMode === "team" || room.gameMode === "team_vs_team") {
        if (team && (team === "orange" || team === "blue")) {
          assignedTeam = team;
        } else {
          // Auto-assign to balance teams
          const participants = await RoomParticipant.findAll({
            where: { roomId: room.id, isActive: true },
          });
          assignedTeam = assignTeamRandomly(participants);
        }
      }

      participant = await RoomParticipant.create({
        roomId: room.id,
        userId: req.user.id,
        team: assignedTeam,
        isDrawer: false,
        hasPaidEntry: true,
      });
    }

    // Get updated participant count after join
    const updatedParticipantCount = await RoomParticipant.count({
      where: { roomId: room.id, isActive: true },
    });

    res.json({
      success: true,
      room: {
        id: room.id,
        code: room.isPublic ? undefined : room.code, // Only show code for private rooms
        name: room.name,
        roomType: room.roomType,
        language: room.language,
        category: room.category,
        voiceEnabled: room.voiceEnabled,
        status: room.status,
        maxPlayers: room.maxPlayers,
        participantCount: updatedParticipantCount,
      },
      participant: {
        id: participant.id,
        team: participant.team,
        score: participant.score,
      },
    });
  } catch (err) {
    console.error("Join room by ID error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

// CREATE PUBLIC ROOM (for when no random matches found) - Protected by global middleware
router.post("/create-public", async (req, res) => {
  try {
    const { language, category, country, voiceEnabled, name } = req.body;

    // Validate required parameters
    if (!language || !category || !country || voiceEnabled === undefined) {
      return res.status(400).json({
        error: "missing_parameters",
        message: "language, category, country, and voiceEnabled are required",
      });
    }

    // Find theme by category
    let themeId = null;
    if (category) {
      const theme = await Theme.findOne({ where: { title: category } });
      if (theme) themeId = theme.id;
    }

    // Generate code but don't expose it for public rooms
    const code = generateRoomCode();

    const room = await Room.create({
      name: name || `${category} Room`,
      code,
      ownerId: req.user.id,
      roomType: "multiplayer",
      language,
      country,
      category,
      voiceEnabled,
      isPublic: true,
      maxPlayers: 15,
      themeId,
      status: "waiting",
    });

    // Owner joins automatically
    await RoomParticipant.create({
      roomId: room.id,
      userId: req.user.id,
      isDrawer: false,
    });

    res.json({
      success: true,
      room: {
        id: room.id,
        // No code for public rooms
        name: room.name,
        roomType: room.roomType,
        language: room.language,
        country: room.country,
        category: room.category,
        voiceEnabled: room.voiceEnabled,
        isPublic: room.isPublic,
        maxPlayers: room.maxPlayers,
        status: room.status,
        participantCount: 1,
      },
    });
  } catch (err) {
    console.error("Create public room error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

// CREATE TEAM VS TEAM ROOM - Protected by global middleware
router.post("/create-team", async (req, res) => {
  try {
    const {
      name,
      language,
      script,
      country,
      pointsTarget,
      category,
      gamePlay,
      voiceEnabled,
      isPublic,
      team, // User's chosen team (A or B)
    } = req.body;

    const code = generateRoomCode();

    let themeId = null;
    if (category) {
      const theme = await Theme.findOne({ where: { title: category } });
      if (theme) themeId = theme.id;
    }

    const room = await Room.create({
      name: name || `Team Battle`,
      code,
      ownerId: req.user.id,
      roomType: "team_vs_team",
      gameMode: "team",
      language,
      script,
      country,
      entryPoints: pointsTarget || 250,
      targetPoints: pointsTarget || 100,
      category,
      gamePlay,
      voiceEnabled: voiceEnabled !== undefined ? voiceEnabled : true,
      isPublic: isPublic !== undefined ? isPublic : true,
      maxPlayers: 8, // 4v4 max for team mode
      isTeamMode: true,
      themeId,
      status: "waiting",
    });

    // Owner joins with chosen team
    await RoomParticipant.create({
      roomId: room.id,
      userId: req.user.id,
      team: team || "A",
      isDrawer: false,
    });

    res.json({
      success: true,
      room: {
        id: room.id,
        code: room.isPublic ? undefined : room.code, // Only show code for private rooms
        name: room.name,
        roomType: room.roomType,
        category: room.category,
        maxPlayers: room.maxPlayers,
        participantCount: 1,
      },
    });
  } catch (err) {
    console.error("Create team room error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

// LIST PUBLIC ROOMS (for multiplayer lobby) - Protected by global middleware
router.get("/list", async (req, res) => {
  try {
    const {
      language,
      script,
      country,
      pointsTarget,
      category,
      gameMode,
      roomType,
      voiceEnabled,
    } = req.query;

    console.log("📋 List rooms request:", {
      language,
      script,
      country,
      pointsTarget,
      category,
      gameMode,
      roomType,
      voiceEnabled,
    });

    const where = {
      isPublic: true,
      status: { [Op.in]: ["lobby", "waiting"] },
      gameMode: { [Op.in]: ["team", "team_vs_team"] },
    };
    
    if (pointsTarget) where.entryPoints = parseInt(pointsTarget);
    if (language) where.language = language;
    if (script) where.script = script;
    if (country) where.country = country;
    if (pointsTarget) where.entryPoints = parseInt(pointsTarget);
    if (category) where.category = category;
    if (gameMode) where.gameMode = gameMode;
    if (roomType) where.roomType = roomType;
    if (voiceEnabled !== undefined)
      where.voiceEnabled = voiceEnabled === "true";

    console.log("🔍 Searching for rooms with filters:", where);

    const rooms = await Room.findAll({
      where,
      include: [
        {
          model: RoomParticipant,
          as: "participants",
          where: { isActive: true },
          required: false,
          include: [
            { model: User, as: "user", attributes: ["id", "name", "avatar"] },
          ],
        },
      ],
      limit: 50,
      order: [["createdAt", "DESC"]],
    });

    console.log(`✅ Found ${rooms.length} rooms matching filters`);

    const roomList = rooms
      .filter((room) => {
        const participantCount = room.participants
          ? room.participants.length
          : 0;

        const notFull = participantCount < room.maxPlayers;
        const hasPlayers = participantCount > 0; // 👈 ADDED LINE — HIDE EMPTY ROOMS

        if (!notFull) {
          console.log(
            `  ⚠️  Filtering out full room ${room.id}: ${participantCount}/${room.maxPlayers}`,
          );
        }

        if (!hasPlayers) {
          console.log(
            `  🚫 Filtering out empty room ${room.id} (0 participants)`,
          );
        }

        return notFull && hasPlayers;
      })
      .map((room) => ({
        id: room.id,
        code: room.isPublic ? undefined : room.code,
        name: room.name,
        roomType: room.roomType,
        language: room.language,
        category: room.category,
        targetPoints: room.targetPoints,
        gamePlay: room.gamePlay,
        voiceEnabled: room.voiceEnabled,
        status: room.status,
        maxPlayers: room.maxPlayers,
        participantCount: room.participants ? room.participants.length : 0,
        entryPoints: room.entryPoints,
        gameMode: room.gameMode,
      }));

    console.log(
      `📤 Returning ${roomList.length} rooms after hiding empty and full rooms`,
    );

    res.json({ success: true, rooms: roomList });
  } catch (err) {
    console.error("List rooms error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

// GET ROOM DETAILS - Protected by global middleware
router.get("/:roomId", async (req, res) => {
  try {
    const room = await Room.findByPk(req.params.roomId, {
      include: [
        {
          model: User,
          as: "owner",
          attributes: ["id", "name", "avatar"],
        },
        {
          model: RoomParticipant,
          as: "participants",
          where: { isActive: true },
          required: false,
          include: [
            {
              model: User,
              as: "user",
              attributes: ["id", "name", "avatar", "coins"],
            },
          ],
        },
        {
          model: Theme,
          as: "theme",
          attributes: ["id", "title"],
        },
      ],
    });

    if (!room) {
      return res.status(404).json({ error: "room_not_found" });
    }
    console.log(room.isPublic);
    res.json({ success: true, room });
  } catch (err) {
    console.error("Get room error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

// LEAVE ROOM - Protected by global middleware
router.post("/:roomId/leave", async (req, res) => {
  try {
    const participant = await RoomParticipant.findOne({
      where: {
        roomId: req.params.roomId,
        userId: req.user.id,
      },
    });

    if (!participant) {
      return res.status(404).json({ error: "not_in_room" });
    }

    participant.isActive = false;
    await participant.save();

    console.log(
      `👋 User ${req.user.id} left room ${req.params.roomId} via HTTP`,
    );

    // Check if room is now empty and close it
    const activeParticipants = await RoomParticipant.count({
      where: { roomId: req.params.roomId, isActive: true },
    });

    if (activeParticipants === 0) {
      // No active participants left, close the room
      await Room.update(
        { status: "closed" },
        { where: { id: req.params.roomId } },
      );

      const room = await Room.findByPk(req.params.roomId);
      if (room) {
        console.log(
          `🏠 Room ${req.params.roomId} (${room.name}) closed via HTTP - no active participants`,
        );
      }
    }

    res.json({ success: true, message: "left_room" });
  } catch (err) {
    console.error("Leave room error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

module.exports = router;
