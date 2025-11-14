module.exports = (sequelize, DataTypes) => {
  const Report = sequelize.define('Report', {
    id: { 
      type: DataTypes.BIGINT.UNSIGNED, 
      primaryKey: true, 
      autoIncrement: true 
    },
    roomId: { 
      type: DataTypes.BIGINT.UNSIGNED, 
      allowNull: false 
    },
    userToBlockId: { 
      type: DataTypes.BIGINT.UNSIGNED, 
      allowNull: false 
    },
    reportedBy: { 
      type: DataTypes.JSON, 
      defaultValue: [],
      allowNull: false 
    },
    reportCount: { 
      type: DataTypes.INTEGER, 
      defaultValue: 0,
      allowNull: false 
    }
  }, { 
    tableName: 'reports',
    indexes: [
      { unique: true, fields: ['roomId', 'userToBlockId'] },
      { fields: ['roomId'] },
      { fields: ['userToBlockId'] }
    ]
  });

  return Report;
};

