const sequelize = require('../config/database');
const { DataTypes } = require('sequelize');

const User = require('./user')(sequelize, DataTypes);
const Room = require('./room')(sequelize, DataTypes);
const RoomParticipant = require('./roomParticipant')(sequelize, DataTypes);
const Theme = require('./theme')(sequelize, DataTypes);
const Word = require('./word')(sequelize, DataTypes);
const Message = require('./message')(sequelize, DataTypes);
const CoinTransaction = require('./coinTransaction')(sequelize, DataTypes);
const Token = require('./token')(sequelize, DataTypes);
const Report = require('./report')(sequelize, DataTypes);
const Language = require('./language')(sequelize, DataTypes);
const Keyword = require('./keyword')(sequelize, DataTypes);
const Translation = require('./translation')(sequelize, DataTypes);

// Associations
User.hasMany(Room, { foreignKey: 'ownerId' });
Room.belongsTo(User, { foreignKey: 'ownerId', as: 'owner' });

// Room-User many-to-many through RoomParticipant
Room.belongsToMany(User, { through: RoomParticipant, foreignKey: 'roomId', otherKey: 'userId' });
User.belongsToMany(Room, { through: RoomParticipant, foreignKey: 'userId', otherKey: 'roomId' });

// Direct associations for RoomParticipant
Room.hasMany(RoomParticipant, { foreignKey: 'roomId', as: 'participants' });
RoomParticipant.belongsTo(Room, { foreignKey: 'roomId' });
RoomParticipant.belongsTo(User, { foreignKey: 'userId', as: 'user' });
User.hasMany(RoomParticipant, { foreignKey: 'userId' });

Theme.hasMany(Word, { foreignKey: 'themeId' });
Word.belongsTo(Theme, { foreignKey: 'themeId' });

Theme.hasMany(Room, { foreignKey: 'themeId' });
Room.belongsTo(Theme, { foreignKey: 'themeId', as: 'theme' });

Room.hasMany(Message, { foreignKey: 'roomId' });
Message.belongsTo(Room, { foreignKey: 'roomId' });
User.hasMany(Message, { foreignKey: 'userId' });
Message.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(CoinTransaction, { foreignKey: 'userId' });
CoinTransaction.belongsTo(User, { foreignKey: 'userId' });

// Keyword-Translation-Language associations
Keyword.hasMany(Translation, { foreignKey: 'keywordId', as: 'translations' });
Translation.belongsTo(Keyword, { foreignKey: 'keywordId', as: 'keyword' });
Language.hasMany(Translation, { foreignKey: 'languageId', as: 'translations' });
Translation.belongsTo(Language, { foreignKey: 'languageId', as: 'language' });

// Theme-Keyword many-to-many association (using junction table)
Theme.belongsToMany(Keyword, { 
  through: 'theme_keywords', 
  foreignKey: 'themeId', 
  otherKey: 'keywordId',
  as: 'keywords'
});
Keyword.belongsToMany(Theme, { 
  through: 'theme_keywords', 
  foreignKey: 'keywordId', 
  otherKey: 'themeId',
  as: 'themes'
});

module.exports = {
  sequelize,
  User,
  Room,
  RoomParticipant,
  Theme,
  Word,
  Message,
  CoinTransaction,
  Token,
  Report,
  Language,
  Keyword,
  Translation
};
