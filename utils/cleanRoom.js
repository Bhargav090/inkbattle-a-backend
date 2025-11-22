const { Room, RoomParticipant } = require("../models");

async function deleteRoom(io, room) {
  try {
    const { clearRoomTimer } = require("../sockets/roundPhases");
    console.log(`🗑 Deleting room: ${room.code}`);

    // 1. Clear timers
    clearRoomTimer(`${room.code}_phase`);
    clearRoomTimer(`${room.code}_drawing`);

    // 2. Remove participants
    await RoomParticipant.destroy({ where: { roomId: room.id } });

    // 3. Remove the room itself
    await room.destroy();

    // 4. Notify all remaining sockets (safety)
    io.to(room.code).emit("room_closed", { roomCode: room.code });

    // 5. Force all sockets out
    const sockets = await io.in(room.code).fetchSockets();
    sockets.forEach((s) => s.leave(room.code));

    return true;
  } catch (err) {
    console.error("Room deletion error:", err);
    return false;
  }
}

async function checkAndMaybeDeleteRoom(io, roomId) {
  const room = await Room.findByPk(roomId);
  if (!room) return;

  const participants = await RoomParticipant.findAll({
    where: { roomId, isActive: true },
  });

  const count = participants.length;

  // ❌ Case 1: No players
  if (count === 0) {
    return deleteRoom(io, room);
  }

  // ❌ Case 2: Owner not present
  const ownerPresent = participants.some((p) => p.userId === room.ownerId);
  if (!ownerPresent) {
    return deleteRoom(io, room);
  }
}

module.exports = { deleteRoom, checkAndMaybeDeleteRoom };
