const { Room, RoomParticipant, User, Word } = require("../models");
const { PHASE_DURATIONS, checkGameEnd } = require("./gameHelpers");
const {
  getWordsForTheme,
  getRandomWordForTheme,
} = require("../utils/wordSelector");
const { checkAndMaybeDeleteRoom } = require("../utils/cleanRoom");

// Store active timers
const roomTimers = new Map();

function clearRoomTimer(key) {
  if (roomTimers.has(key)) {
    clearTimeout(roomTimers.get(key));
    clearInterval(roomTimers.get(key));
    roomTimers.delete(key);
  }
}

// === NEW HELPER FUNCTION: Starts a continuous countdown timer for any phase ===
async function startPhaseTimerAndBroadcast(
  io,
  room,
  phaseKey,
  duration,
  onEndCallback,
) {
  clearRoomTimer(`${room.code}_phase`);
  const roomCode = room.code;

  // 1. Initialize remaining time in the database
  room.roundPhase = phaseKey;
  room.roundRemainingTime = duration;
  room.roundPhaseEndTime = new Date(Date.now() + duration * 1000);
  await room.save();

  // 2. Broadcast initial phase change event
  io.to(roomCode).emit("phase_change", {
    phase: phaseKey,
    duration: duration,
    // Include other necessary phase-specific data here if needed
    round: room.currentRound,
  });

  console.log(`⏱️ Phase started: ${phaseKey}. Duration: ${duration}s`);

  // 3. Start the interval ticker
  const interval = setInterval(async () => {
    const refreshedRoom = await Room.findByPk(room.id);
    if (
      !refreshedRoom ||
      refreshedRoom.roundPhase !== phaseKey ||
      refreshedRoom.roundRemainingTime <= 0
    ) {
      clearInterval(interval);
      clearRoomTimer(`${roomCode}_${phaseKey}`);

      if (refreshedRoom && refreshedRoom.roundPhase === phaseKey) {
        // If the timer ended naturally, execute the callback (transition to next phase)
        await onEndCallback(io, refreshedRoom);
      }
      return;
    }

    // Decrement time and save to database
    refreshedRoom.roundRemainingTime -= 1;
    await refreshedRoom.save();

    // Broadcast time update to all clients
    io.to(roomCode).emit("time_update", {
      remainingTime: refreshedRoom.roundRemainingTime,
    });
  }, 1000);

  roomTimers.set(`${roomCode}_${phaseKey}`, interval);
}

// Start a new round
async function startNewRound(io, room) {
  try {
    // Clear chat for new round
    io.to(room.code).emit("clear_chat");

    // Get active participants
    const participants = await RoomParticipant.findAll({
      where: { roomId: room.id, isActive: true },
      include: [{ model: User, as: "user" }],
    });

    if (participants.length < 2) {
      io.to(room.code).emit("error", { message: "not_enough_players" });
      return;
    }

    // Reset guess status
    await RoomParticipant.update(
      { hasGuessedThisRound: false, isDrawer: false },
      { where: { roomId: room.id } },
    );

    console.log(`🎯 Round ${room.currentRound} - Selecting drawer...`);

    // Start the selection process which now uses the ticking timer
    await selectDrawerAndStartWordChoice(io, room);
  } catch (e) {
    console.error("Start new round error:", e);
  }
}

// Select drawer and start word choice phase
async function selectDrawerAndStartWordChoice(io, room) {
  try {
    clearRoomTimer(`${room.code}_phase`);

    // Reload fresh room object
    room = await Room.findByPk(room.id);
    if (!room) return;

    // Load active participants
    let participants = await RoomParticipant.findAll({
      where: { roomId: room.id, isActive: true },
      include: [{ model: User, as: "user" }],
    });

    if (!participants.length) {
      console.log("⚠️ No participants in room:", room.code);
      return;
    }

    // Sort participants for a stable rotation order
    participants.sort((a, b) => a.userId - b.userId);

    // Ensure pointer is valid
    let pointer = room.drawerPointerIndex || 0;
    pointer = pointer % participants.length;

    // Select drawer by pointer
    const nextDrawer = participants[pointer];

    // Move pointer to next for next rotation
    pointer = (pointer + 1) % participants.length;

    // Save pointer + drawer
    await RoomParticipant.update(
      { isDrawer: false },
      { where: { roomId: room.id, isDrawer: true } },
    ); // Clear old drawer status
    await RoomParticipant.update(
      { isDrawer: true },
      { where: { id: nextDrawer.id } },
    ); // Set new drawer status

    room.drawerPointerIndex = pointer;
    room.currentDrawerId = nextDrawer.userId;
    room.lastDrawerId = nextDrawer.userId;
    room.currentWord = null;
    room.currentWordOptions = null;
    await room.save();

    console.log(
      `🎯 Drawer selected: ${nextDrawer.user?.name ?? "Guest"} (ID: ${nextDrawer.userId})`,
    );
    console.log(`👥 Total participants: ${participants.length}`);
    console.log(`🔁 Next pointer index: ${pointer}`);

    // --- Word selection logic ---
    let words = [];
    if (room.themeId) {
      try {
        words = await getRandomWordForTheme(
          room.themeId,
          room.language,
          room.script,
          3,
        );
      } catch (e) {
        console.log("⚠️ Error loading themed words, fallback being used");
      }
    }
    console.log(words);
    if (!words || words.length < 3) {
      const fallback = [
        "apple",
        "banana",
        "cat",
        "dog",
        "elephant",
        "flower",
        "guitar",
        "house",
        "tree",
        "sun",
      ];
      words = fallback.sort(() => 0.5 - Math.random()).slice(0, 3);
    }
    room.currentWordOptions = words;
    await room.save();

    const drawerPayload = {
      id: nextDrawer.userId,
      name: nextDrawer.user?.name ?? "Guest",
      team: nextDrawer.team,
      avatar: nextDrawer.user?.avatar,
    };

    // ----------------------------------------------------
    // PHASE 1: selecting_drawer (Preview) - Now uses ticker
    // ----------------------------------------------------
    await startPhaseTimerAndBroadcast(
      io,
      room,
      "selecting_drawer",
      PHASE_DURATIONS.selecting_drawer,
      async (io, refreshedRoom) => {
        // Timer ended, transition to choosing_word
        await startWordChoicePhase(
          io,
          refreshedRoom,
          nextDrawer,
          words,
          drawerPayload,
        );
      },
    );

    io.to(room.code).emit("drawer_selected", {
      drawer: drawerPayload,
      previewDuration: PHASE_DURATIONS.selecting_drawer,
    });
  } catch (err) {
    console.error("Select drawer error:", err);
  }
}

// NEW FUNCTION: Handles the word choice phase transition
async function startWordChoicePhase(
  io,
  room,
  nextDrawer,
  words,
  drawerPayload,
) {
  const drawerSocket = Array.from(io.sockets.sockets.values()).find(
    (s) => s.user && s.user.id === nextDrawer.userId,
  );

  // Send word list to drawer only
  if (drawerSocket) {
    drawerSocket.emit("word_options", {
      words,
      duration: PHASE_DURATIONS.choosing_word,
    });
  }

  // ----------------------------------------------------
  // PHASE 2: choosing_word - Now uses ticker
  // ----------------------------------------------------
  await startPhaseTimerAndBroadcast(
    io,
    room,
    "choosing_word",
    PHASE_DURATIONS.choosing_word,
    async (io, currentRoom) => {
      // Timer ended, drawer timed out (original chooseTimer logic)
      console.log(`⏰ Drawer ${drawerPayload.name} timed out. Skipping.`);

      await RoomParticipant.update(
        { isDrawer: false },
        { where: { roomId: currentRoom.id, userId: nextDrawer.userId } },
      );
      currentRoom.currentDrawerId = null;
      currentRoom.currentWord = null;
      currentRoom.currentWordOptions = null;
      currentRoom.roundPhase = "selecting_drawer";
      await currentRoom.save();

      io.to(room.code).emit("drawer_skipped", { drawer: drawerPayload });

      // Continue rotation
      await selectDrawerAndStartWordChoice(io, currentRoom);
    },
  );
}

// Start drawing phase
async function startDrawingPhase(io, room) {
  try {
    clearRoomTimer(`${room.code}_phase`);

    room.roundPhase = "drawing";
    room.roundRemainingTime = PHASE_DURATIONS.drawing;
    room.roundStartTime = new Date();
    room.roundPhaseEndTime = new Date(
      Date.now() + PHASE_DURATIONS.drawing * 1000,
    );
    await room.save();

    const wordHint = room.currentWord
      .split("")
      .map(() => "_")
      .join(" ");

    io.to(room.code).emit("phase_change", {
      phase: "drawing",
      duration: PHASE_DURATIONS.drawing,
      wordHint,
      word: room.currentWord, // Only drawer will use this
    });

    console.log(`🎨 Drawing phase started - Word: ${room.currentWord}`);

    // Timer that ticks every second
    const interval = setInterval(async () => {
      const refreshedRoom = await Room.findByPk(room.id);
      if (
        refreshedRoom.roundPhase !== "drawing" ||
        refreshedRoom.roundRemainingTime <= 0
      ) {
        clearInterval(interval);
        clearRoomTimer(`${room.code}_drawing`);
        if (refreshedRoom.roundPhase === "drawing") {
          await endDrawingPhase(io, refreshedRoom);
        }
        return;
      }

      refreshedRoom.roundRemainingTime -= 1;
      await refreshedRoom.save();

      io.to(refreshedRoom.code).emit("time_update", {
        remainingTime: refreshedRoom.roundRemainingTime,
      });
    }, 1000);

    roomTimers.set(`${room.code}_drawing`, interval);
  } catch (e) {
    console.error("Start drawing phase error:", e);
  }
}

// End drawing phase and start reveal
async function endDrawingPhase(io, room) {
  try {
    clearRoomTimer(`${room.code}_drawing`);

    // Award points to drawer based on how many guessed
    const guessedCount = await RoomParticipant.count({
      where: { roomId: room.id, hasGuessedThisRound: true },
    });

    const drawer = await RoomParticipant.findOne({
      where: { roomId: room.id, userId: room.currentDrawerId },
      include: [{ model: User, as: "user" }],
    });

    if (drawer && guessedCount > 0) {
      const drawerReward = Math.min(guessedCount * 2, room.maxPointsPerRound);
      drawer.score += drawerReward;
      await drawer.save();

      console.log(
        `🎨 Drawer ${drawer.user?.name} earned ${drawerReward} points (${guessedCount} guessed)`,
      );
    }

    // Start reveal phase
    room.roundPhase = "reveal";
    room.roundPhaseEndTime = new Date(
      Date.now() + PHASE_DURATIONS.reveal * 1000,
    );
    await room.save();

    // Get updated participants for scores
    const participants = await RoomParticipant.findAll({
      where: { roomId: room.id, isActive: true },
      include: [{ model: User, as: "user" }],
    });

    io.to(room.code).emit("phase_change", {
      phase: "reveal",
      duration: PHASE_DURATIONS.reveal,
      word: room.currentWord,
      drawerReward: drawer
        ? Math.min(guessedCount * 2, room.maxPointsPerRound)
        : 0,
      participants: participants.map((p) => ({
        id: p.userId,
        name: p.user?.name || "Guest",
        score: p.score,
        team: p.team,
      })),
    });

    console.log(`📢 Reveal phase - Word was: ${room.currentWord}`);

    // Check if game should end
    const gameEnded = await checkGameEnd(io, room);
    if (gameEnded) {
      return;
    }

    // Wait then start interval
    const timer = setTimeout(async () => {
      await startIntervalPhase(io, room);
    }, PHASE_DURATIONS.reveal * 1000);

    roomTimers.set(`${room.code}_phase`, timer);
  } catch (e) {
    console.error("End drawing phase error:", e);
  }
}

// Start interval phase
async function startIntervalPhase(io, room) {
  try {
    room = await Room.findByPk(room.id);

    // ----------------------------------------------------
    // PHASE 3: interval - Uses the startPhaseTimer pattern
    // ----------------------------------------------------
    await startPhaseTimerAndBroadcast(
      io,
      room,
      "interval",
      PHASE_DURATIONS.interval,
      async (io, refreshedRoom) => {
        // Timer ended, transition to new round
        refreshedRoom.currentRound += 1;
        await refreshedRoom.save();
        await startNewRound(io, refreshedRoom);
      },
    );

    io.to(room.code).emit("phase_change", {
      phase: "interval",
      duration: PHASE_DURATIONS.interval,
    });

    console.log(`⏸️ Interval phase`);
  } catch (e) {
    console.error("Start interval phase error:", e);
  }
}

async function handleDrawerLeave(io, room, userId) {
  try {
    if (room.currentDrawerId !== userId || room.roundPhase !== "drawing") {
      return false; // Not the current drawer or not in drawing phase
    }

    console.log(
      `🚨 Current drawer (${userId}) left the room ${room.code}. Initiating phase change.`,
    );

    // 1. Clear any active round timers (drawing/hint/etc.)
    clearRoomTimer(`${room.code}_drawing`);

    // 2. Clear current drawing state in the Room model
    room.currentDrawerId = null;
    room.currentWord = null;
    room.currentWordOptions = null;

    // Set interval end time
    room.roundPhaseEndTime = new Date(
      Date.now() + PHASE_DURATIONS.interval * 1000,
    );

    await room.save();

    // 3. Start the interval phase using the ticking timer
    await startPhaseTimerAndBroadcast(
      io,
      room,
      "interval",
      PHASE_DURATIONS.interval,
      async (io, refreshedRoom) => {
        // Timer ended, transition to new round
        await startNewRound(io, refreshedRoom);
      },
    );
    await checkAndMaybeDeleteRoom(io, room.id);

    return true; // Drawer leave successfully handled
  } catch (error) {
    console.error("Error handling drawer leave:", error);
    return false;
  }
}

async function handleOwnerLeave(io, room, userId) {
  if (room.ownerId !== userId) return false;
  console.log(`Owner Left the room`);
  const { deleteRoom } = require("../utils/cleanRoom");

  console.log(`🚨 Owner (${userId}) left room ${room.code}. Deleting room.`);
  await deleteRoom(io, room);
  return true;
}
module.exports = {
  startNewRound,
  selectDrawerAndStartWordChoice,
  startDrawingPhase,
  endDrawingPhase,
  startIntervalPhase,
  clearRoomTimer,
  roomTimers,
  handleDrawerLeave,
  handleOwnerLeave,
  startWordChoicePhase, // Exporting new helper function for external use if needed
  startPhaseTimerAndBroadcast, // Exporting new helper function
};
