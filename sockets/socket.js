/*
Socket.IO handlers for InkBattle Game - REFACTORED VERSION
Features:
- Lobby-based settings
- Round phases with timers
- Dynamic points system
- Team vs Team mode
- Entry coins deduction
- Game end with rankings
*/

const { verify } = require("../utils/auth");
const {
  Room,
  RoomParticipant,
  User,
  Message,
  CoinTransaction,
  Theme,
} = require("../models");
const {
  calculateEntryCost,
  calculateGuessReward,
  calculateTimeReduction,
} = require("./gameHelpers");
const {
  startNewRound,
  startDrawingPhase,
  clearRoomTimer,
  handleDrawerLeave,
  handleOwnerLeave,
} = require("./roundPhases");
const sdpTransform = require("sdp-transform");
const voiceManager = require("./voiceManager");

module.exports = function (io) {
  // Authentication middleware
  io.use(async (socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next();
    const payload = verify(token);
    const user = await User.findByPk(payload.id);
    if (payload) socket.user = user; // receiving only id
    next();
  });

  io.on("connection", (socket) => {
    console.log(
      "✅ Socket connected:",
      socket.id,
      socket.user ? `User: ${socket.user.name}` : "anonymous",
    );

    // JOIN ROOM
    socket.on("join_room", async ({ roomCode, roomId }) => {
      try {
        let room;
        if (roomCode) {
          room = await Room.findOne({ where: { code: roomCode } });
        } else if (roomId) {
          room = await Room.findByPk(roomId);
        }

        if (!room) {
          return socket.emit("error", { message: "room_not_found" });
        }

        // --- NEW: Check if the user is a REJOINING participant ---
        let existingParticipant = null;
        if (socket.user) {
          existingParticipant = await RoomParticipant.findOne({
            where: { roomId: room.id, userId: socket.user.id },
          });
        }

        const isRejoining =
          existingParticipant && !existingParticipant.isActive;
        // -----------------------------------------------------------

        // Only perform the room_full check for NEW players.
        if (!isRejoining) {
          const activeParticipants = await RoomParticipant.count({
            where: { roomId: room.id, isActive: true },
          });

          if (activeParticipants >= room.maxPlayers) {
            return socket.emit("error", {
              message: "room_full",
              details: `Room is full. Max players: ${room.maxPlayers}`,
            });
          }
        }

        socket.join(room.code);
        socket.currentRoom = room.code;

        // Reactivate room if it was inactive (This logic is fine for resume)
        if (room.status === "inactive") {
          await Room.update(
            { status: room.isPublic ? "waiting" : "lobby" },
            { where: { id: room.id } },
          );
          room.status = room.isPublic ? "waiting" : "lobby";
          console.log(
            `🔄 Room ${room.id} (${room.name}) reactivated from inactive state`,
          );
        }

        let isNewParticipant = false; // Add this flag for clean logging/DB insertion

        if (socket.user) {
          if (existingParticipant) {
            // --- RESUME LOGIC: Update participant status and socket ID ---
            await RoomParticipant.update(
              { socketId: socket.id, isActive: true },
              { where: { roomId: room.id, userId: socket.user.id } },
            );
            console.log(
              `✅ User ${socket.user.name} RESUMED game in room ${room.code}`,
            );
          } else {
            // --- NEW PARTICIPANT LOGIC (You may need to insert a new participant here) ---
            // Assuming participant creation happens elsewhere (e.g., /api/rooms/join),
            // but if it happens implicitly here, you would add the creation logic.
            // For now, we only handle updates for existing users who already joined once.

            // If you are sure a user has an active/inactive record when they hit join_room,
            // this 'else' branch may not be needed, but it guards against missing records.
            isNewParticipant = true; // Set flag
            await RoomParticipant.create({
              // Example creation for new player
              roomId: room.id,
              userId: socket.user.id,
              socketId: socket.id,
              isActive: true,
              // Set default scores, team, etc.
            });
          }
        }

        // --- Fetch ALL participants (including the newly resumed/active one) ---
        const participants = await RoomParticipant.findAll({
          where: { roomId: room.id, isActive: true },
          include: [
            {
              model: User,
              as: "user",
              attributes: ["id", "name", "avatar", "coins"],
            },
          ],
        });

        const participantList = participants.map((p) => ({
          id: p.userId,
          name: p.user ? p.user.name : "Guest",
          avatar: p.user ? p.user.avatar : null,
          coins: p.user ? p.user.coins : 0,
          score: p.score,
          team: p.team,
          isDrawer: p.isDrawer,
          socketId: p.socketId,
          hasPaidEntry: p.hasPaidEntry,
          // The client uses score/team/isDrawer/etc. to resume the state.
        }));
        // --------------------------------------------------------------------------

        // --- Emit room_joined to the rejoining client, including isResuming flag ---
        socket.emit("room_joined", {
          room: {
            id: room.id,
            code: room.code,
            name: room.name,
            status: room.status,
            gameMode: room.gameMode,
            category: room.category,
            language: room.language,
            script: room.script,
            country: room.country,
            voiceEnabled: room.voiceEnabled,
            currentRound: room.currentRound,
            maxPlayers: room.maxPlayers,
            entryPoints: room.entryPoints,
            targetPoints: room.targetPoints,
            isPublic: room.isPublic,
            ownerId: room.ownerId,
            // The resume feature relies on the client receiving these:
            roundPhase: room.roundPhase,
            roundRemainingTime: room.roundRemainingTime,
            // The entire room object serves as the Game State for the client.
          },
          participants: participantList,
          isResuming: isRejoining, // <--- NEW: Flag for the client
        });
        // --------------------------------------------------------------------------

        // Broadcast updated participant list to ALL room members
        io.to(room.code).emit("room_participants", {
          participants: participantList,
        });

        // Notify others that a player joined/rejoined
        socket.to(room.code).emit("player_joined", {
          userName: socket.user ? socket.user.name : "Guest",
          userId: socket.user ? socket.user.id : null,
          isRejoining: isRejoining, // <--- NEW: Notify others
        });

        // Log for clarity
        if (!isRejoining && !isNewParticipant) {
          console.log(
            `👤 User ${socket.user ? socket.user.name : "Guest"} joined room ${room.code}`,
          );
        }

        // NOTE: You may also need to emit the full **drawing history** if the game is 'playing'
        // This is often stored in a separate temporary cache (e.g., Redis) indexed by room ID.
        if (room.status === "playing") {
          const currentDrawerId = room.currentDrawerId;
          const resumingSocketId = socket.id;
          // Find the active drawer's socket ID
          const drawerParticipant = participantList.find(
            (p) => p.id === currentDrawerId,
          );
          if (drawerParticipant && drawerParticipant.socketId) {
            const drawerSocketId = drawerParticipant.socketId;

            // 2. Emit a specific event to the Drawer's socket, requesting the drawing data
            io.to(drawerSocketId).emit("request_canvas_data", {
              roomCode: room.code,
              targetSocketId: resumingSocketId, // Tell the drawer where to send the data
            });

            console.log(
              `📡 Requested canvas data from drawer ${drawerParticipant.name} for resuming user ${socket.user?.name}`,
            );
          } else {
            console.warn(
              `⚠️ Room ${room.code} is playing, but drawer socket not found.`,
            );
            // You may need to handle a scenario where the drawer disconnected mid-round.
          }
        }
      } catch (e) {
        console.error("Join room error:", e);
        socket.emit("error", { message: "join_room_failed" });
      }
    });
    // Resume Feature
    socket.on(
      "send_canvas_data",
      async ({ roomCode, targetSocketId, history, remainingTime }) => {
        console.log("Received canvas data:", history);
        // 1. Check if the room is valid (optional but good security)
        const room = await Room.findOne({ where: { code: roomCode } });
        if (!room) return socket.emit("error", { message: "room_not_found" });

        // 2. Directly emit the data to the single target socket ID
        io.to(targetSocketId).emit("canvas_resume", {
          roomCode: roomCode,
          history: history,
          room: room,
          remainingTime: remainingTime,
        });

        console.log(
          `➡️ Forwarded canvas data to resuming user: ${targetSocketId}`,
        );
      },
    );

    socket.on("update_settings", async ({ roomId, settings }) => {
      const VOICE_CHAT_COST = 50;

      try {
        const room = await Room.findByPk(roomId);
        if (!room) return socket.emit("error", { message: "room_not_found" });

        // Basic authorization checks
        if (room.ownerId !== socket.user?.id) {
          return socket.emit("error", { message: "only_owner_can_update" });
        }

        if (room.status !== "lobby" && room.status !== "waiting") {
          return socket.emit("error", {
            message: "cannot_update_after_game_started",
          });
        }

        // --- VOICE CHAT FEE LOGIC ---
        if (
          settings.voiceEnabled !== undefined &&
          settings.voiceEnabled === true &&
          room.voiceEnabled === false
        ) {
          // 1. Fetch all active participants and their User models
          const participants = await RoomParticipant.findAll({
            where: { roomId: room.id, isActive: true },
            include: [{ model: User, as: "user" }],
          });

          const insufficientFundsUsers = [];
          const usersToCharge = [];

          // 2. Check Balances for all users
          for (const participant of participants) {
            if (!participant.user) continue;

            if (participant.user.coins < VOICE_CHAT_COST) {
              insufficientFundsUsers.push(participant.user.name);
            } else {
              usersToCharge.push(participant.user);
            }
          }

          // 3. Handle Insufficient Funds (Block and Notify All)
          if (insufficientFundsUsers.length > 0) {
            const names = insufficientFundsUsers.join(", ");
            const errorMessage = `Voice chat requires ${VOICE_CHAT_COST} coins from everyone. Users lacking funds: ${names}.`;

            // Broadcast error to everyone in the room (not just the owner)
            io.to(room.code).emit("error", {
              message: "insufficient_coins",
              details: errorMessage,
              usersAffected: insufficientFundsUsers,
            });

            // Do NOT update room.voiceEnabled and return
            return;
          }

          // 4. Charge Users and Update Database (Transaction Recommended, but simplified here)
          const chargePromises = usersToCharge.map((user) => {
            user.coins -= VOICE_CHAT_COST;
            return user.save();
          });
          await Promise.all(chargePromises);

          room.voiceEnabled = settings.voiceEnabled;

          io.to(room.code).emit("error", {
            message: `Voice chat enabled! ${VOICE_CHAT_COST} coins charged from all active participants.`,
          });
        } else if (
          settings.voiceEnabled !== undefined &&
          settings.voiceEnabled === false
        ) {
          room.voiceEnabled = settings.voiceEnabled;
        }
        if (settings.gameMode !== undefined) room.gameMode = settings.gameMode;
        if (settings.language !== undefined) room.language = settings.language;
        if (settings.script !== undefined) room.script = settings.script;
        if (settings.country !== undefined) room.country = settings.country;
        if (settings.category !== undefined) {
          room.category = settings.category;
          const theme = await Theme.findOne({
            where: { title: settings.category },
          });
          room.themeId = theme ? theme.id : null;
        }
        if (settings.entryPoints !== undefined) {
          if (settings.voiceEnabled === true)
            room.entryPoints = settings.entryPoints + VOICE_CHAT_COST;
          else room.entryPoints = settings.entryPoints;
        }
        if (settings.targetPoints !== undefined)
          room.targetPoints = settings.targetPoints;

        if (settings.isPublic !== undefined) {
          room.isPublic = settings.isPublic;
          if (settings.isPublic === true && room.status === "lobby") {
            room.status = "waiting";
          }
          if (settings.isPublic === false && room.status === "waiting") {
            room.status = "lobby";
          }
        }
        if (settings.maxPlayers !== undefined)
          room.maxPlayers = settings.maxPlayers;

        await room.save();
        let data = {
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
        };
        io.to(room.code).emit("settings_updated", data);

        console.log(
          `⚙️ Room ${room.id} settings updated  \n${JSON.stringify(data)}`,
        );
      } catch (e) {
        console.error("Update settings error:", e);
        socket.emit("error", { message: "update_settings_failed" });
      }
    });

    // SELECT TEAM
    socket.on("select_team", async ({ roomId, team }) => {
      try {
        if (!team || (team !== "orange" && team !== "blue")) {
          return socket.emit("error", { message: "invalid_team" });
        }

        // Reload room to get latest gameMode
        const room = await Room.findByPk(roomId);
        if (!room) return socket.emit("error", { message: "room_not_found" });

        // Allow team changes in lobby and waiting status (before game starts)
        if (room.status !== "lobby" && room.status !== "waiting") {
          return socket.emit("error", {
            message: "cannot_change_team_after_game_started",
          });
        }

        // Check if game mode supports team selection
        if (room.gameMode !== "team" && room.gameMode !== "team_vs_team") {
          return socket.emit("error", {
            message: "not_team_mode",
            details: `Team selection is only available in team mode. Current mode: ${room.gameMode || "unknown"}`,
          });
        }

        const participant = await RoomParticipant.findOne({
          where: { roomId: room.id, userId: socket.user.id },
        });

        if (!participant) {
          return socket.emit("error", { message: "not_in_room" });
        }

        participant.team = team;
        await participant.save();

        // Reload participant with user info for logging
        await participant.reload({ include: [{ model: User, as: "user" }] });

        const participants = await RoomParticipant.findAll({
          where: { roomId: room.id, isActive: true },
          include: [
            {
              model: User,
              as: "user",
              attributes: ["id", "name", "avatar", "coins"],
            },
          ],
        });

        console.log(
          `👥 User ${participant.user?.name || socket.user?.name || "Unknown"} selected team ${team}`,
        );

        io.to(room.code).emit("room_participants", {
          participants: participants.map((p) => ({
            id: p.userId,
            name: p.user ? p.user.name : "Guest",
            avatar: p.user ? p.user.avatar : null,
            coins: p.user ? p.user.coins : 0,
            score: p.score,
            team: p.team,
            isDrawer: p.isDrawer,
            socketId: p.socketId,
            hasPaidEntry: p.hasPaidEntry,
          })),
        });

        console.log(`👥 User ${socket.user.name} selected team ${team}`);
      } catch (e) {
        console.error("Select team error:", e);
        socket.emit("error", { message: "select_team_failed" });
      }
    });

    // START GAME
    socket.on("start_game", async ({ roomCode, roomId }) => {
      try {
        console.log(
          `🎮 Start game request from socket ${socket.id}, user: ${socket.user?.id}, roomId: ${roomId}, roomCode: ${roomCode}`,
        );

        let room;
        if (roomCode) {
          room = await Room.findOne({ where: { code: roomCode } });
        } else if (roomId) {
          room = await Room.findByPk(roomId);
        }
        if (!room) {
          console.log(`❌ Room not found: ${roomId || roomCode}`);
          return socket.emit("error", { message: "room_not_found" });
        }

        console.log(
          `🏠 Room found: ${room.id}, owner: ${room.ownerId}, current user: ${socket.user?.id}, status: ${room.status}`,
        );

        if (!socket.user || !socket.user.id) {
          console.log(`❌ User not authenticated`);
          return socket.emit("error", { message: "not_authenticated" });
        }

        if (room.ownerId !== socket.user.id) {
          console.log(
            `❌ User ${socket.user.id} is not owner (owner is ${room.ownerId})`,
          );
          return socket.emit("error", { message: "only_owner_can_start" });
        }

        // Allow starting game from both lobby and waiting status
        if (room.status !== "lobby" && room.status !== "waiting") {
          console.log(`❌ Game already started, status: ${room.status}`);
          return socket.emit("error", { message: "game_already_started" });
        }

        const participants = await RoomParticipant.findAll({
          where: { roomId: room.id, isActive: true },
          include: [{ model: User, as: "user" }],
        });

        if (participants.length < 2) {
          return socket.emit("error", { message: "not_enough_players" });
        }

        // For team mode, check both teams have players
        if (room.gameMode === "team_vs_team") {
          const orangeCount = participants.filter(
            (p) => p.team === "orange",
          ).length;
          const blueCount = participants.filter(
            (p) => p.team === "blue",
          ).length;

          if (orangeCount === 0 || blueCount === 0) {
            return socket.emit("error", { message: "both_teams_need_players" });
          }
        }

        const entryCost = calculateEntryCost(
          room.entryPoints,
          room.voiceEnabled,
        );

        // Deduct entry coins from all participants
        for (const participant of participants) {
          const user = await User.findByPk(participant.userId);
          if (!user) continue;

          // Skip if already paid
          if (participant.hasPaidEntry) {
            console.log(`💰 ${user.name} already paid entry fee`);
            continue;
          }

          if (user.coins < entryCost) {
            return socket.emit("error", {
              message: "insufficient_coins",
              details: `${user.name} needs ${entryCost} coins to play`,
            });
          }

          user.coins -= entryCost;
          await user.save();

          await CoinTransaction.create({
            userId: user.id,
            amount: -entryCost,
            reason: "game_entry",
          });

          participant.hasPaidEntry = true;
          await participant.save();

          console.log(`💰 Deducted ${entryCost} coins from ${user.name}`);
        }

        room.status = "playing";
        room.currentRound = 1;
        room.drawnUserIds = []; // Reset drawer rotation for new game
        await room.save();

        io.to(room.code).emit("game_started", {
          room: {
            status: room.status,
            entryCost: entryCost,
          },
        });

        console.log(`🎮 Game started in room ${room.code}`);

        await startNewRound(io, room);
      } catch (e) {
        console.error("Start game error:", e);
        socket.emit("error", {
          message: "start_game_failed",
          details: e.message,
        });
      }
    });

    // CHOOSE WORD
    socket.on("choose_word", async ({ roomId, word }) => {
      try {
        const room = await Room.findByPk(roomId);
        if (!room) return;

        if (room.currentDrawerId !== socket.user?.id) {
          return socket.emit("error", { message: "not_your_turn" });
        }

        if (room.roundPhase !== "choosing_word") {
          return socket.emit("error", { message: "wrong_phase" });
        }

        if (
          !room.currentWordOptions ||
          !room.currentWordOptions.includes(word)
        ) {
          return socket.emit("error", { message: "invalid_word_choice" });
        }

        room.currentWord = word;
        room.currentWordOptions = null;
        await room.save();

        console.log(`📝 Drawer chose word: ${word}`);

        await startDrawingPhase(io, room);
      } catch (e) {
        console.error("Choose word error:", e);
      }
    });

    // DRAWING DATA
    socket.on("drawing_data", async ({ roomCode, roomId, strokes }) => {
      try {
        let room;
        if (roomCode) {
          room = await Room.findOne({ where: { code: roomCode } });
        } else if (roomId) {
          room = await Room.findByPk(roomId);
        }
        if (room && room.roundPhase === "drawing") {
          // Broadcast to all users in the room (including sender for sync, but frontend filters)
          io.to(room.code).emit("drawing_data", { strokes, from: socket.id });
          console.log(`🎨 Drawing data broadcasted to room ${room.code}`);
        } else {
          console.log(
            `⚠️ Drawing data ignored - room phase: ${room?.roundPhase}, room: ${room?.code}`,
          );
        }
      } catch (e) {
        console.error("Drawing data error:", e);
      }
    });

    // CLEAR CANVAS
    socket.on("clear_canvas", async ({ roomCode, roomId }) => {
      try {
        let room;
        if (roomCode) {
          room = await Room.findOne({ where: { code: roomCode } });
        } else if (roomId) {
          room = await Room.findByPk(roomId);
        }
        if (room) {
          io.to(room.code).emit("canvas_cleared", {
            by: socket.user ? socket.user.name : "Someone",
          });
        }
      } catch (e) {
        console.error("Clear canvas error:", e);
      }
    });

    // CHAT MESSAGE
    socket.on("chat_message", async ({ roomCode, roomId, content, avatar }) => {
      console.log(avatar);
      try {
        let room;
        if (roomCode) {
          room = await Room.findOne({ where: { code: roomCode } });
        } else if (roomId) {
          room = await Room.findByPk(roomId);
        }
        if (!room) return;

        const userId = socket.user ? socket.user.id : null;
        const msg = await Message.create({
          roomId: room.id,
          userId,
          content,
          type: "text",
        });

        let user = { id: null, name: "Guest", avatar: avatar };
        if (userId) {
          const dbUser = await User.findByPk(userId);
          if (dbUser) {
            user = {
              id: dbUser.id,
              name: dbUser.name,
              avatar: dbUser.avatar,
            };
          }
        }

        io.to(room.code).emit("chat_message", {
          id: msg.id,
          content: msg.content,
          user,
          createdAt: msg.createdAt,
          type: "text",
        });
      } catch (e) {
        console.error("Chat message error:", e);
      }
    });

    // SUBMIT GUESS
    socket.on("submit_guess", async ({ roomCode, roomId, guess }) => {
      try {
        let room;
        // 1. Find Room
        if (roomCode) {
          room = await Room.findOne({ where: { code: roomCode } });
        } else if (roomId) {
          room = await Room.findByPk(roomId);
        }

        if (!room) {
          return socket.emit("guess_result", {
            ok: false,
            message: "room_not_found",
          });
        }

        // 2. Initial Checks (Phase, Word, Authentication)
        if (room.roundPhase !== "drawing") {
          return socket.emit("guess_result", {
            ok: false,
            message: "not_drawing_phase",
          });
        }

        if (!room.currentWord) {
          return socket.emit("guess_result", {
            ok: false,
            message: "no_active_word",
          });
        }

        if (!socket.user || !socket.user.id) {
          return socket.emit("guess_result", {
            ok: false,
            message: "not_authenticated",
          });
        }

        // 3. Find Participant
        const participant = await RoomParticipant.findOne({
          where: { roomId: room.id, userId: socket.user.id },
        });

        if (!participant) {
          return socket.emit("guess_result", {
            ok: false,
            message: "not_in_room",
          });
        }

        // 4. Drawer cannot guess
        if (participant.isDrawer) {
          return socket.emit("guess_result", {
            ok: false,
            message: "drawer_cannot_guess",
          });
        }

        // 5. BLOCK: Only block if the player has already guessed the correct word.
        if (participant.hasGuessedThisRound) {
          return socket.emit("guess_result", {
            ok: false,
            message: "already_guessed",
          });
        }

        // 6. Team Check (Team vs Team Mode)
        if (room.gameMode === "team_vs_team") {
          const drawer = await RoomParticipant.findOne({
            where: { roomId: room.id, userId: room.currentDrawerId },
          });

          if (!drawer || participant.team !== drawer.team) {
            return socket.emit("guess_result", {
              ok: false,
              message: "wrong_team",
            });
          }
        }

        // 7. Process Guess
        const normalized = (guess || "").toString().trim().toLowerCase();
        const word = room.currentWord.toString().trim().toLowerCase();
        const isCorrect = normalized === word;

        if (isCorrect) {
          // --- CORRECT GUESS LOGIC ---
          const reward = calculateGuessReward(
            room.roundRemainingTime,
            room.maxPointsPerRound,
          );

          // Award points (team or individual)
          if (room.gameMode === "team_vs_team") {
            // Award to entire team
            const teamParticipants = await RoomParticipant.findAll({
              where: {
                roomId: room.id,
                team: participant.team,
                isActive: true,
              },
            });

            for (const teamMember of teamParticipants) {
              teamMember.score += reward;
              await teamMember.save();
            }
          } else {
            participant.score += reward;
            await participant.save();
          }

          // FIX: ONLY MARK as guessed IF the guess was correct.
          participant.hasGuessedThisRound = true;
          await participant.save();
          // END FIX

          // Reduce time, broadcast, and check for round end (unchanged)
          const activePlayers = await RoomParticipant.count({
            where: { roomId: room.id, isActive: true, isDrawer: false },
          });

          if (activePlayers > 0) {
            const timeReduction = calculateTimeReduction(
              room.roundRemainingTime,
              activePlayers,
            );
            room.roundRemainingTime = Math.max(
              0,
              room.roundRemainingTime - timeReduction,
            );
            await room.save();
          }

          io.to(room.code).emit("correct_guess", {
            by: { id: socket.user.id, name: socket.user.name },
            word: room.currentWord,
            points: reward,
            participant: {
              id: participant.userId,
              name: socket.user.name,
              score: participant.score,
              team: participant.team,
              avatar: participant.avatar,
            },
            remainingTime: room.roundRemainingTime,
          });

          // Check if all eligible players guessed
          const eligibleCount =
            room.gameMode === "team_vs_team"
              ? await RoomParticipant.count({
                  where: {
                    roomId: room.id,
                    isActive: true,
                    isDrawer: false,
                    team: participant.team,
                  },
                })
              : await RoomParticipant.count({
                  where: { roomId: room.id, isActive: true, isDrawer: false },
                });

          const guessedCount = await RoomParticipant.count({
            where: {
              roomId: room.id,
              isActive: true,
              hasGuessedThisRound: true,
            },
          });

          if (guessedCount >= eligibleCount) {
            // Everyone guessed, end round early
            const { endDrawingPhase } = require("./roundPhases");
            clearRoomTimer(`${room.code}_drawing`);
            await endDrawingPhase(io, room);
          }
        } else {
          // --- INCORRECT GUESS LOGIC ---
          // FIX: DO NOT mark hasGuessedThisRound = true here.
          // The participant remains eligible to guess.

          // Get user info for broadcast
          const user = await User.findByPk(socket.user.id);
          const userName = user ? user.name : "Unknown";

          // Broadcast incorrect guess to all users in the room
          io.to(room.code).emit("incorrect_guess", {
            guess: guess,
            user: {
              id: socket.user.id,
              name: userName,
            },
          });

          // Also send result to sender
          socket.emit("guess_result", {
            ok: false,
            message: "incorrect",
            guess: guess,
            avatar: user.avatar,
          });
          // END FIX
        }
      } catch (e) {
        console.error("Submit guess error:", e);
      }
    });
    // Drawer skipped
    socket.on("skip_turn", async ({ roomId }) => {
      const room = await Room.findByPk(roomId);
      if (!room) return;
      await RoomParticipant.update(
        { isDrawer: false },
        { where: { roomId: room.id } },
      );

      room.currentDrawerId = null;
      room.currentWord = null;
      room.currentWordOptions = null;

      const participants = await RoomParticipant.findAll({
        where: { roomId: room.id, isActive: true },
        include: [{ model: User, as: "user" }],
      });

      if (participants.length < 2) {
        io.to(room.code).emit("error", { message: "not_enough_players" });
        return;
      }
      await room.save();
      const { selectDrawerAndStartWordChoice } = require("./roundPhases");
      selectDrawerAndStartWordChoice(io, room);
    });

    // WORD HINT (from drawer)
    socket.on(
      "word_hint",
      async ({ roomCode, roomId, revealedWord, hintsRemaining }) => {
        try {
          let room;
          if (roomCode) {
            room = await Room.findOne({ where: { code: roomCode } });
          } else if (roomId) {
            room = await Room.findByPk(roomId);
          }

          if (room && room.roundPhase === "drawing") {
            // Broadcast hint to all users in the room
            io.to(room.code).emit("word_hint", {
              revealedWord: revealedWord,
              hintsRemaining: hintsRemaining,
            });
            console.log(
              `💡 Word hint broadcasted to room ${room.code}: ${revealedWord}`,
            );
          }
        } catch (e) {
          console.error("Word hint error:", e);
        }
      },
    );

    // LEAVE ROOM
    socket.on("leave_room", async ({ roomCode, roomId }) => {
      try {
        let room;
        if (roomCode) {
          room = await Room.findOne({ where: { code: roomCode } });
        } else if (roomId) {
          room = await Room.findByPk(roomId);
        }

        if (room) {
          socket.leave(room.code);

          if (socket.user) {
            // 1. Set participant inactive
            await RoomParticipant.update(
              { isActive: false, socketId: null },
              { where: { roomId: room.id, userId: socket.user.id } },
            );

            console.log(`👋 User ${socket.user.name} left room ${room.code}`);

            // 2. CHECK IF LEAVING USER WAS THE DRAWER
            if (room.ownerId == socket.user.id) {
              await handleOwnerLeave(io, room, socket.user.id);
            } else if (room.status === "playing") {
              await handleDrawerLeave(io, room, socket.user.id);
            }
            // END DRAWER CHECK

            const roomClosed = await checkAndCloseEmptyRoom(io, room.id);

            if (!roomClosed) {
              // 3. Broadcast updated participant list
              const participants = await RoomParticipant.findAll({
                where: { roomId: room.id, isActive: true },
                include: [
                  {
                    model: User,
                    as: "user",
                    attributes: ["id", "name", "avatar", "coins"],
                  },
                ],
              });

              io.to(room.code).emit("room_participants", {
                participants: participants.map((p) => ({
                  id: p.userId,
                  name: p.user ? p.user.name : "Guest",
                  avatar: p.user ? p.user.avatar : null,
                  coins: p.user ? p.user.coins : 0,
                  score: p.score,
                  team: p.team,
                  isDrawer: p.isDrawer,
                  socketId: p.socketId,
                  hasPaidEntry: p.hasPaidEntry,
                })),
              });
            }
          }
        }
      } catch (e) {
        console.error("Leave room error:", e);
      }
    });

    socket.on("join_voice", async ({ roomId, userId }) => {
      // Added 'async'
      try {
        console.log(
          `🔊 Socket ${socket.id} joining voice room ${roomId} and ${userId}`,
        );
        const router = await voiceManager.join(socket.id, roomId);

        socket.data.roomId = roomId;
        socket.data.userId = userId;
        if (!router) {
          console.log(`❌ join_voice Router not found for room ${roomId}`);
          return socket.emit("error", {
            message: `Router for room ${roomId} not found`,
          });
        }

        // 1. Get router capabilities
        const routerRtpCapabilities = router.rtpCapabilities;

        // 2. Create send transport on server
        const { transport, params: sendTransportParams } =
          await voiceManager.createTransport(router);
        voiceManager.addTransport(socket.id, transport); // Store transport for later use

        // 3. Get existing producers
        const existingProducers = voiceManager.getProducers(roomId, socket.id);

        // Send initial setup data back to client
        socket.emit("voice_setup", {
          // CHANGED: Renamed from 'voice_ready' to 'voice_setup'
          routerRtpCapabilities,
          sendTransportParams,
          existingProducers, // Added existing producers
        });

        // Store room ID on socket for easier access in other handlers
        socket.room_id = roomId;

        // Notify others of a new user joining the voice channel (optional, but good practice)
        socket.to(roomId).emit("user_joined_voice", {
          userId: socket.user?.id,
          socketId: socket.id,
        });
      } catch (e) {
        console.error("Join voice error:", e);
        socket.emit("error", { message: "join_voice_failed" });
      }
    });
    // --- 1. Router RTP Capabilities ---
    socket.on("get_router_rtp_capabilities", (data) => {
      const router = voiceManager.getRouter(socket.room_id);
      if (router) {
        socket.emit("router_rtp_capabilities", router.rtpCapabilities);
      } else {
        console.log(
          `❌ get_router_rtp_capabilities Router not found for room ${socket.room_id}`,
        );
        socket.emit("error", {
          message: `Router for room ${socket.room_id} not found`,
        });
      }
    });

    // --- 2. Create Transport ---
    socket.on("create_transport", async (data) => {
      try {
        const router = voiceManager.getRouter(socket.room_id);
        if (!router) {
          console.log(
            `❌ create_transport Router not found for room ${socket.room_id}`,
          );
          return socket.emit("error", {
            message: `Router for room ${socket.room_id} not found`,
          });
        }

        const { transport, params } =
          await voiceManager.createTransport(router);
        voiceManager.addTransport(socket.id, transport);

        // Send transport params back to client
        socket.emit("transport_created", params);
      } catch (err) {
        console.error("Create transport error:", err);
        socket.emit("error", { message: err.message });
      }
    });

    // --- 3. Connect Transport ---
    socket.on("connect_transport", async (data) => {
      try {
        const { dtlsParameters, direction } = data;

        const transport = await voiceManager.connectTransport(
          socket.id,
          dtlsParameters,
        );

        if (!transport) {
          return socket.emit("error", {
            message: `Transport for socket ${socket.id} not found or failed to connect`,
          });
        }

        socket.emit("transport_connected", {
          direction: direction || "send",
          ok: true,
        });
        console.log(
          `✅ ${direction || "send"} transport connected for socket ${socket.id}`,
        );
      } catch (err) {
        console.error("Connect transport error:", err);
        socket.emit("error", { message: err.message });
      }
    });

    // --- 4. Produce (send audio) ---
    socket.on("produce", async (data) => {
      try {
        const transport = voiceManager.getTransport(socket.id);
        if (!transport) {
          return socket.emit("error", {
            message: `Transport for socket ${socket.id} not found`,
          });
        }
        if (voiceManager.getProducerBySocketId(socket.id)) {
          console.log(
            `⚠️ Producer already exists for ${socket.id}, skipping duplicate`,
          );
          return;
        }
        const producer = await transport.produce({
          kind: data.kind,
          rtpParameters: data.rtpParameters,
          appData: { userId: socket.user?.id, socketId: socket.id },
        });

        voiceManager.addProducer(socket.id, producer);

        // Notify others that a new producer appeared
        const otherSocketIds = voiceManager.getOtherSocketIds(
          socket.id,
          socket.room_id,
        );
        for (const otherSocketId of otherSocketIds) {
          io.to(otherSocketId).emit("new_producer", {
            producerId: producer.id,
            userId: socket.user?.id,
          });
        }

        socket.emit("producer_created", { id: producer.id });
      } catch (err) {
        console.error("Produce error:", err);
        socket.emit("error", { message: err.message });
      }
    });

    // --- 5. Consume (receive audio) ---

    socket.on("consume", async (data) => {
      try {
        const transport = voiceManager.getTransport(socket.id);
        if (!transport) {
          return socket.emit("error", {
            message: `Transport for socket ${socket.id} not found`,
          });
        }

        const producer = voiceManager.getProducer(data.producerId);
        if (!producer) {
          return socket.emit("error", {
            message: `Producer with id ${data.producerId} not found`,
          });
        }

        const router = voiceManager.getRouter(socket.room_id);
        if (
          !router ||
          !router.canConsume({
            producerId: producer.id,
            rtpCapabilities: data.rtpCapabilities,
          })
        ) {
          return socket.emit("error", {
            message: "Cannot consume this producer",
          });
        }

        // ✅ Check if consumer already exists for this socket/producer pair
        const existingConsumer = voiceManager.getConsumerByProducerId(
          socket.id,
          data.producerId,
        );
        if (existingConsumer) {
          console.log(
            `⚠️ Consumer already exists for socket ${socket.id} and producer ${data.producerId}`,
          );
          return; // Don't create duplicate
        }

        // Create the consumer
        const consumer = await transport.consume({
          producerId: producer.id,
          rtpCapabilities: data.rtpCapabilities,
          paused: true,
        });
        voiceManager.addConsumer(socket.id, consumer);

        // Parse the client offer SDP
        const offer = data.offer ? sdpTransform.parse(data.offer) : null;

        // Build server-side SDP answer
        const sdpAnswer = voiceManager._buildConsumerAnswerSdp({
          router,
          consumer,
          offer,
        });

        // ✅ Only emit once
        socket.emit("consumer_created", {
          id: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          sdp: sdpAnswer,
        });
        consumer.resume();
        console.log(
          `🎧 Created consumer ${consumer.id} for producer ${producer.id}`,
        );
      } catch (err) {
        console.error("❌ Consume error:", err);
        socket.emit("error", { message: err.message });
      }
    });

    socket.on("consumer_offer", async (data) => {
      try {
        const { producerId, offerSdp } = data;
        const room = voiceManager.getRoom(socket);
        if (!room) throw new Error("Room not found for this socket");
        const router = room.router;
        const sdpTransform = require("sdp-transform");

        console.log(
          `📥 consumer_offer from ${socket.id} for producer ${producerId}`,
        );

        const offer = sdpTransform.parse(offerSdp);
        const media = offer.media.find((m) => m.type === "audio");
        if (!media) throw new Error("No audio m= section found in offer");

        // Find recv transport
        const recvTransport = voiceManager.getTransport(socket.id);
        if (!recvTransport) throw new Error("Recv transport not found");

        // Find the producer
        const producer = voiceManager.getProducer(producerId);
        if (!producer) throw new Error("Producer not found");

        // Create the consumer
        const consumer = await recvTransport.consume({
          producerId: producer.id,
          rtpCapabilities: router.rtpCapabilities,
          paused: false,
        });

        voiceManager.addConsumer(socket.id, consumer);
        console.log(
          `🎧 Created consumer ${consumer.id} for producer ${producer.id}`,
        );

        // Build SDP answer using your helper
        const sdpAnswer = voiceManager._buildConsumerAnswerSdp({
          router,
          consumer,
          offer,
        });
        await consumer.resume();
        if (socket.data.lastConsumerAnswerId === consumer.id) return;
        socket.data.lastConsumerAnswerId = consumer.id;
        socket.emit("consumer_answer", {
          consumerId: consumer.id,
          sdp: sdpAnswer,
        });

        console.log(`✅ Sent consumer_answer for ${consumer.id}`);
      } catch (err) {
        console.error("❌ Error handling consumer_offer:", err);
      }
    });

    // --- 6. Resume Consumer ---
    socket.on("resume_consumer", async (data) => {
      try {
        const consumer = voiceManager.getConsumer(socket.id, data.consumerId);
        if (consumer) {
          await consumer.resume();
          socket.emit("consumer_resumed", { id: data.consumerId });
        } else {
          socket.emit("error", {
            message: `Consumer ${data.consumerId} not found`,
          });
        }
      } catch (err) {
        console.error("Resume consumer error:", err);
        socket.emit("error", { message: err.message });
      }
    });

    // --- 7. Get Producers in Room ---
    socket.on("get_producers", (data) => {
      const producers = voiceManager.getProducers(socket.room_id, socket.id);
      socket.emit("producers_list", producers);
    });

    // 7. Handle standard socket disconnect (CRITICAL CLEANUP)
    socket.on("disconnect", async () => {
      console.log("❌ Socket disconnected:", socket.id);

      const { roomId, userId, producerId } = voiceManager.handleDisconnect(
        socket.id,
      );

      if (roomId && userId) {
        // Notify others in the room
        const otherSockets = voiceManager.getOtherSocketIds(socket.id, roomId);
        for (const otherSocketId of otherSockets) {
          io.to(otherSocketId).emit("user_left_voice", { userId });
          if (producerId) {
            io.to(otherSocketId).emit("producer_closed", { producerId });
          }
        }
      }

      // 7b. Game Cleanup (RoomParticipant/Room status)
      if (socket.user && socket.currentRoom) {
        try {
          const room = await Room.findOne({
            where: { code: socket.currentRoom },
          });
          if (room) {
            await RoomParticipant.update(
              { isActive: false, socketId: null },
              { where: { roomId: room.id, userId: socket.user.id } },
            );
            await checkAndCloseEmptyRoom(io, room.id);
          }
        } catch (e) {
          console.error("Disconnect cleanup error:", e);
        }
      }
    });
  });
};

// Check and deactivate empty room
async function checkAndCloseEmptyRoom(io, roomId) {
  try {
    const activeParticipants = await RoomParticipant.count({
      where: { roomId: roomId, isActive: true },
    });

    const room = await Room.findByPk(roomId);
    if (!room) return false;

    if (activeParticipants === 1) {
      // Set room to inactive instead of finished, so it can be reactivated
      await Room.update({ status: "inactive" }, { where: { id: roomId } });

      clearRoomTimer(room.code);
      io.to(room.code).emit("room_closed", {
        message: "Room is now inactive - no active participants",
      });
      console.log(
        `💤 Room ${roomId} (${room.name}) set to inactive (0 participants)`,
      );

      return true;
    }

    return false;
  } catch (error) {
    console.error("Error checking empty room:", error);
    return false;
  }
}
