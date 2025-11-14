module.exports = (sequelize, DataTypes) => {
  const RoomParticipant = sequelize.define('RoomParticipant', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    roomId: { type: DataTypes.BIGINT.UNSIGNED },
    userId: { type: DataTypes.BIGINT.UNSIGNED },
    
    // Team assignment for team_vs_team mode ('orange' or 'blue')
    team: { type: DataTypes.STRING, allowNull: true }, // 'orange' or 'blue'
    
    isDrawer: { type: DataTypes.BOOLEAN, defaultValue: false },
    score: { type: DataTypes.INTEGER, defaultValue: 0 }, // Points in current game
    
    // Track if player has drawn in current game
    hasDrawn: { type: DataTypes.BOOLEAN, defaultValue: false },
    
    // Track if player has guessed correctly in current round
    hasGuessedThisRound: { type: DataTypes.BOOLEAN, defaultValue: false },
    
    // Track entry payment
    hasPaidEntry: { type: DataTypes.BOOLEAN, defaultValue: false },
    
    // Player status
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    socketId: { type: DataTypes.STRING, allowNull: true }
  }, { tableName: 'room_participants' });

  return RoomParticipant;
};
