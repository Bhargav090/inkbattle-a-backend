module.exports = (sequelize, DataTypes) => {
  const Room = sequelize.define('Room', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    code: { type: DataTypes.STRING },
    name: { type: DataTypes.STRING, allowNull: true },
    ownerId: { type: DataTypes.BIGINT.UNSIGNED },
    
    // Game mode: '1v1' (multiplayer free-for-all) or 'team_vs_team'
    gameMode: { type: DataTypes.STRING, defaultValue: '1v1' }, // '1v1' or 'team_vs_team'
    
    // Lobby settings (configurable before game starts)
    language: { type: DataTypes.STRING, allowNull: true }, // EN, TE, HI
    script: { type: DataTypes.STRING, allowNull: true }, // All, Native, Roman
    country: { type: DataTypes.STRING, allowNull: true }, // All, India, USA, etc
    category: { type: DataTypes.STRING, allowNull: true }, // Fruits, Animals, Food, Movies (theme)
    
    // Entry and rewards system
    entryPoints: { type: DataTypes.INTEGER, defaultValue: 250 }, // 100, 250, 500
    targetPoints: { type: DataTypes.INTEGER, defaultValue: 100 }, // Points needed to win
    maxPointsPerRound: { type: DataTypes.INTEGER, defaultValue: 10 }, // Max points per round
    
    maxPlayers: { type: DataTypes.INTEGER, defaultValue: 15 },
    voiceEnabled: { type: DataTypes.BOOLEAN, defaultValue: false },
    isPublic: { type: DataTypes.BOOLEAN, defaultValue: false }, // Default private
    
    // Game state
    status: { type: DataTypes.STRING, defaultValue: 'lobby' }, // lobby, playing, finished
    currentWord: { type: DataTypes.STRING, allowNull: true },
    currentWordOptions: { type: DataTypes.JSON, allowNull: true }, // 3 word choices for drawer
    currentDrawerId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    currentRound: { type: DataTypes.INTEGER, defaultValue: 0 },
    roundStartTime: { type: DataTypes.DATE, allowNull: true },
    roundPhase: { type: DataTypes.STRING, allowNull: true }, // 'selecting_drawer', 'choosing_word', 'drawing', 'reveal', 'interval'
    roundPhaseEndTime: { type: DataTypes.DATE, allowNull: true },
    roundRemainingTime: { type: DataTypes.INTEGER, defaultValue: 80 }, // Drawing time in seconds
    drawerPointerIndex: {
  type: DataTypes.INTEGER,
  defaultValue: 0,
},
    // Theme reference
    themeId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    
    // Track who has drawn (for fair rotation)
    drawnUserIds: {
      type: DataTypes.JSON,
      defaultValue: [],
      // FIX: The getter ensures that if the database returns null or {}, 
      // JavaScript receives a safe empty array instead.
      get() {
        const value = this.getDataValue('drawnUserIds');
        return Array.isArray(value) ? value : [];
      },
      // The setter is optional but good practice to ensure only arrays are saved.
      set(val) {
        this.setDataValue('drawnUserIds', Array.isArray(val) ? val : []);
      },
    }
  }, { 
    tableName: 'rooms',
    indexes: [
      { unique: true, fields: ['code'] }
    ]
  },);

  return Room;
};