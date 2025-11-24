const {
  Room,
  RoomParticipant,
  User,
  Word,
  CoinTransaction,
} = require("../models");

// Phase durations in seconds
const PHASE_DURATIONS = {
  selecting_drawer: 5,
  choosing_word: 10,
  drawing: 80,
  reveal: 7,
  interval: 4,
  lobby_timeout: 2 * 60, //2 min
};

// Calculate entry cost
// Entry cost is exactly the configured points value (no voice bonus)
function calculateEntryCost(entryPoints, voiceEnabled) {
  return entryPoints;
}

// Calculate reward based on remaining time
function calculateGuessReward(remainingTime, maxPoints) {
  return Math.min(Math.ceil(remainingTime / 8), maxPoints);
}

// Calculate time reduction after correct guess
function calculateTimeReduction(remainingTime, numPlayers) {
  return Math.floor(remainingTime / numPlayers);
}

// Check if game should end (someone reached target)
async function checkGameEnd(io, room) {
  const participants = await RoomParticipant.findAll({
    where: { roomId: room.id, isActive: true },
    include: [{ model: User, as: "user" }],
    order: [["score", "DESC"]],
  });

  const winner = participants.find((p) => p.score >= room.targetPoints);

  if (winner) {
    await endGame(io, room, participants);
    return true;
  }

  return false;
}

// End game and award coins
async function endGame(io, room, participants) {
  try {
    room.status = "finished";
    await room.save();

    // Sort by score
    participants.sort((a, b) => b.score - a.score);

    // Calculate rewards
    const entryCost = calculateEntryCost(room.entryPoints, room.voiceEnabled);
    const rewards = [
      { place: 1, multiplier: 3 },
      { place: 2, multiplier: 2 },
      { place: 3, multiplier: 1 },
    ];

    const rankings = [];

    for (let i = 0; i < Math.min(participants.length, 3); i++) {
      const participant = participants[i];
      const reward = rewards[i];
      const coinsAwarded = entryCost * reward.multiplier;

      const user = await User.findByPk(participant.userId);
      if (user) {
        user.coins += coinsAwarded;
        await user.save();

        await CoinTransaction.create({
          userId: user.id,
          amount: coinsAwarded,
          reason: `game_reward_place_${reward.place}`,
        });

        rankings.push({
          place: reward.place,
          userId: participant.userId,
          name: participant.user?.name || "Guest",
          score: participant.score,
          coinsAwarded,
        });

        console.log(
          `🏆 Place ${reward.place}: ${participant.user?.name} - ${participant.score} points, ${coinsAwarded} coins`,
        );
      }
    }

    // Add remaining players without rewards
    for (let i = 3; i < participants.length; i++) {
      rankings.push({
        place: i + 1,
        userId: participants[i].userId,
        name: participants[i].user?.name || "Guest",
        score: participants[i].score,
        coinsAwarded: 0,
      });
    }

    io.to(room.code).emit("game_ended", {
      rankings,
      entryCost,
    });

    setTimeout(async () => {
      room.status = "lobby";
      await room.save();
    }, 2000);

    console.log(`🎮 Game ended in room ${room.code}`);
  } catch (e) {
    console.error("End game error:", e);
  }
}

module.exports = {
  PHASE_DURATIONS,
  calculateEntryCost,
  calculateGuessReward,
  calculateTimeReduction,
  checkGameEnd,
  endGame,
};
