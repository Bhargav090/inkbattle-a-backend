module.exports = (sequelize, DataTypes) => {
  const Theme = sequelize.define('Theme', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    title: { type: DataTypes.STRING, allowNull: false }
  }, { tableName: 'themes' });

  return Theme;
};
