module.exports = (sequelize, DataTypes) => {
  const Keyword = sequelize.define('Keyword', {
    id: { 
      type: DataTypes.BIGINT.UNSIGNED, 
      primaryKey: true, 
      autoIncrement: true 
    },
    keyName: { 
      type: DataTypes.STRING(100), 
      allowNull: false,
      unique: true 
    },
    category: { 
      type: DataTypes.STRING(100), 
      allowNull: true 
    }
  }, { 
    tableName: 'keywords',
    indexes: [
      { unique: true, fields: ['keyName'] },
      { fields: ['category'] }
    ]
  });

  return Keyword;
};

