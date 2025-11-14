const { Room, RoomParticipant, User, Word } = require("../models");
const { PHASE_DURATIONS, checkGameEnd } = require("./gameHelpers");
const { getWordsForTheme } = require("../utils/wordSelector");

// Store active timers
const roomTimers = new Map();

function clearRoomTimer(key) {
  if (roomTimers.has(key)) {
    clearTimeout(roomTimers.get(key));
    clearInterval(roomTimers.get(key));
    roomTimers.delete(key);
  }
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

    // Start selecting drawer phase
    room.roundPhase = "selecting_drawer";
    room.roundPhaseEndTime = new Date(
      Date.now() + PHASE_DURATIONS.selecting_drawer * 1000,
    );
    await room.save();

    console.log(`🎯 Round ${room.currentRound} - Selecting drawer...`);

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

    // Mark participant as drawer
    nextDrawer.isDrawer = true;
    await nextDrawer.save();

    // ---- Word selection logic (unchanged) ----
    let words = [];
    console.log(`${room.language} ${room.script} ${room.themeId}`);

    if (room.themeId) {
      try {
        words = await getWordsForTheme(
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
    room.roundPhase = "selecting_drawer";
    room.roundPhaseEndTime = new Date(
      Date.now() + PHASE_DURATIONS.selecting_drawer * 1000,
    );
    await room.save();

    const drawerPayload = {
      id: nextDrawer.userId,
      name: nextDrawer.user?.name ?? "Guest",
      team: nextDrawer.team,
    };

    io.to(room.code).emit("drawer_selected", {
      drawer: drawerPayload,
      previewDuration: PHASE_DURATIONS.selecting_drawer,
    });

    io.to(room.code).emit("phase_change", {
      phase: "selecting_drawer",
      duration: PHASE_DURATIONS.selecting_drawer,
      round: room.currentRound,
      drawer: drawerPayload,
    });

    // After preview → move to choosing_word
    const previewTimer = setTimeout(async () => {
      const refreshedRoom = await Room.findByPk(room.id);
      if (!refreshedRoom || refreshedRoom.currentDrawerId !== nextDrawer.userId)
        return;

      refreshedRoom.roundPhase = "choosing_word";
      refreshedRoom.roundPhaseEndTime = new Date(
        Date.now() + PHASE_DURATIONS.choosing_word * 1000,
      );
      await refreshedRoom.save();

      io.to(room.code).emit("phase_change", {
        phase: "choosing_word",
        duration: PHASE_DURATIONS.choosing_word,
        drawer: drawerPayload,
      });

      // Send word list to drawer only
      const drawerSocket = Array.from(io.sockets.sockets.values()).find(
        (s) => s.user && s.user.id === nextDrawer.userId,
      );
      if (drawerSocket) {
        drawerSocket.emit("word_options", {
          words,
          duration: PHASE_DURATIONS.choosing_word,
        });
      }

      // If drawer times out → skip → just call this function again → pointer already moved
      const chooseTimer = setTimeout(async () => {
        const currentRoom = await Room.findByPk(room.id);
        if (!currentRoom || currentRoom.currentDrawerId !== nextDrawer.userId)
          return;

        console.log(`⏰ Drawer ${drawerPayload.name} timed out. Skipping.`);

        // 🔥 BONUS FIX — RESET OLD DRAWER
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
      }, PHASE_DURATIONS.choosing_word * 1000);

      roomTimers.set(`${room.code}_phase`, chooseTimer);
    }, PHASE_DURATIONS.selecting_drawer * 1000);

    roomTimers.set(`${room.code}_phase`, previewTimer);
  } catch (err) {
    console.error("Select drawer error:", err);
  }
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

    room.roundPhase = "interval";
    room.roundPhaseEndTime = new Date(
      Date.now() + PHASE_DURATIONS.interval * 1000,
    );
    room.currentWord = null;
    room.currentWordOptions = null;
    room.currentDrawerId = null;
    await room.save();

    io.to(room.code).emit("phase_change", {
      phase: "interval",
      duration: PHASE_DURATIONS.interval,
    });

    console.log(`⏸️  Interval phase`);

    // Wait then start next round
    const timer = setTimeout(async () => {
      const refreshedRoom = await Room.findByPk(room.id);
      refreshedRoom.currentRound += 1;
      await refreshedRoom.save();
      await startNewRound(io, refreshedRoom);
    }, PHASE_DURATIONS.interval * 1000);

    roomTimers.set(`${room.code}_phase`, timer);
  } catch (e) {
    console.error("Start interval phase error:", e);
  }
}

module.exports = {
  startNewRound,
  selectDrawerAndStartWordChoice,
  startDrawingPhase,
  endDrawingPhase,
  startIntervalPhase,
  clearRoomTimer,
  roomTimers,
};
