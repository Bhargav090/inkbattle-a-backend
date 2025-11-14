const { Keyword, Translation, Language, Theme } = require('../models');
const { Op } = require('sequelize');

/**
 * Get words for a theme based on room's language and script settings
 * @param {number} themeId - Theme ID
 * @param {string} roomLanguage - Room language (EN, TE, HI) or language code (en, te, hi)
 * @param {string} roomScript - Room script ('english' or 'default')
 * @param {number} limit - Optional limit for random words
 * @returns {Promise<Array<string>>} Array of word texts
 */
async function getWordsForTheme(themeId, roomLanguage, roomScript, limit = null) {
  try {
    console.log(`🔍 getWordsForTheme: themeId=${themeId}, language=${roomLanguage}, script=${roomScript}, limit=${limit}`);

    // Normalize language code - handle both capitalized and lowercase versions
    const langCodeMap = {
      'EN': 'en',
      'TE': 'te', 
      'HI': 'hi',
      'English': 'en',
      'english': 'en',
      'Hindi': 'hi',
      'hindi': 'hi',
      'Telugu': 'te',
      'telugu': 'te',
      'Kannada': 'kn',
      'kannada': 'kn',
      'Marathi': 'mr',
      'marathi': 'mr'
    };
    // First check exact match, then try lowercase, then default to 'en'
    const normalizedLangCode = langCodeMap[roomLanguage] || langCodeMap[roomLanguage?.toLowerCase()] || roomLanguage?.toLowerCase() || 'en';
    
    // Normalize script - support both old ('roman', 'native', 'all') and new ('english', 'default') formats
    let normalizedScript = (roomScript || 'default').toLowerCase();
    
    // Legacy support: map old script values to new ones
    if (normalizedScript === 'roman') {
      normalizedScript = 'english';
    } else if (normalizedScript === 'native') {
      normalizedScript = 'default';
    } else if (normalizedScript === 'all') {
      normalizedScript = 'default';
    }
    
    console.log(`   Normalized: langCode=${normalizedLangCode}, script=${normalizedScript}`);

    // NEW LOGIC:
    // 1. If language is English → word_script must be "english" (always return English words)
    // 2. If language is not English:
    //    - word_script = "default" → return romanized translation in user's selected language (e.g., "chetu" for "tree" in Telugu)
    //    - word_script = "english" → return English words
    
    let targetLanguageCode = normalizedLangCode;
    let targetScriptType = 'roman'; // Default to roman script
    
    // Rule 1: If language is English, always use English words
    if (normalizedLangCode === 'en') {
      targetLanguageCode = 'en';
      targetScriptType = 'roman';
      console.log(`   📝 Language is English → Always using English words (word_script=${normalizedScript} is ignored)`);
    } else {
      // Rule 2: For non-English languages, check word_script
      if (normalizedScript === 'english') {
        // User wants English words even though language is not English
        targetLanguageCode = 'en';
        targetScriptType = 'roman';
        console.log(`   📝 Language=${normalizedLangCode}, word_script=english → Using English words`);
      } else if (normalizedScript === 'default') {
        // User wants translation in their selected language, but in romanized form
        // Example: Telugu "default" → "chetu" (romanized Telugu for "tree"), not "చెటు" (native script)
        targetLanguageCode = normalizedLangCode;
        targetScriptType = 'roman';
        console.log(`   📝 Language=${normalizedLangCode}, word_script=default → Using ${normalizedLangCode} romanized words (e.g., "chetu" for tree in Telugu)`);
      } else {
        // Fallback: default to roman if script is invalid
        targetLanguageCode = normalizedLangCode;
        targetScriptType = 'roman';
        console.log(`   📝 Invalid script=${normalizedScript}, defaulting to roman`);
      }
    }

    console.log(`   🎯 Target: language=${targetLanguageCode}, script=${targetScriptType}`);

    // Get theme with keywords
    const theme = await Theme.findByPk(themeId, {
      include: [{
        model: Keyword,
        as: 'keywords',
        include: [{
          model: Translation,
          as: 'translations',
          include: [{
            model: Language,
            as: 'language'
          }]
        }]
      }]
    });

    if (!theme || !theme.keywords || theme.keywords.length === 0) {
      console.log(`   ⚠️  No keywords found for theme ${themeId}`);
      return [];
    }

    console.log(`   Found ${theme.keywords.length} keywords in theme`);

    // Get target language ID
    let language = await Language.findOne({ 
      where: { languageCode: targetLanguageCode } 
    });

    if (!language) {
      console.log(`   ⚠️  Language not found: ${targetLanguageCode}, defaulting to English`);
      const defaultLang = await Language.findOne({ where: { languageCode: 'en' } });
      if (!defaultLang) {
        console.log(`   ❌ English language not found in database!`);
        return [];
      }
      language = defaultLang;
    }

    console.log(`   Using language: ${language.languageName} (${language.languageCode})`);

    // Extract words based on script
    const words = [];
    for (const keyword of theme.keywords) {
      // Debug: Log available translations for this keyword
      const availableTranslations = keyword.translations?.map(t => {
        const langCode = t.language?.languageCode || (t.languageId === language.id ? language.languageCode : 'unknown');
        return `${langCode}:${t.scriptType} (langId:${t.languageId})`;
      }) || [];
      console.log(`   🔍 Keyword "${keyword.keyName}" - Available: [${availableTranslations.join(', ')}]`);
      console.log(`   🎯 Looking for: languageId=${language.id} (${language.languageCode}), scriptType=${targetScriptType}`);
      
      // Find translation matching target language and script
      let translation = keyword.translations?.find(t => {
        const matches = t.languageId === language.id && t.scriptType === targetScriptType;
        if (!matches && t.languageId === language.id) {
          console.log(`     ⚠️  Found same language but different script: ${t.scriptType} (wanted ${targetScriptType})`);
        }
        return matches;
      });

      if (translation) {
        words.push(translation.translatedText);
        console.log(`   ✅ Found ${targetScriptType} translation for "${keyword.keyName}": ${translation.translatedText}`);
      } else {
        // Fallback logic
        if (targetScriptType === 'roman' && targetLanguageCode !== 'en') {
          // If roman not found for non-English language, try native script as fallback
          translation = keyword.translations?.find(t => 
            t.languageId === language.id && t.scriptType === 'native'
          );
          if (translation) {
            words.push(translation.translatedText);
            console.log(`   ⚠️  Roman translation not found for "${keyword.keyName}", using native: ${translation.translatedText}`);
          } else {
            // For 'default' script, we should NOT fallback to English - skip the word if not found
            console.log(`   ❌ No translation found for "${keyword.keyName}" in ${targetLanguageCode} (neither roman nor native)`);
            // Don't add anything - skip this keyword
          }
        } else if (targetScriptType === 'native') {
          // If native not found, try roman script of the same language
          translation = keyword.translations?.find(t => 
            t.languageId === language.id && t.scriptType === 'roman'
          );
          if (translation) {
            words.push(translation.translatedText);
            console.log(`   ⚠️  Native translation not found for "${keyword.keyName}", using roman: ${translation.translatedText}`);
          } else {
            // Only fallback to English if explicitly requested (word_script='english')
            // For 'default', we should NOT fallback to English - skip the word if not found
            console.log(`   ❌ No translation found for "${keyword.keyName}" in ${targetLanguageCode} (neither native nor roman)`);
            // Don't add anything - skip this keyword
          }
        } else {
          // For English roman, if not found, it's an error (English roman should always exist)
          console.log(`   ⚠️  English roman translation not found for "${keyword.keyName}"`);
        }
      }
    }

    console.log(`   Found ${words.length} words after filtering`);

    // If script is 'all' and we got native words, also include roman as backup
    // Actually, for 'all', we should return native by default
    // But if user wants both, we can handle that separately
    
    // Shuffle and limit if needed
    const shuffled = words.sort(() => 0.5 - Math.random());
    const result = limit ? shuffled.slice(0, limit) : shuffled;

    console.log(`   Returning ${result.length} words${limit ? ` (limited to ${limit})` : ''}`);
    
    return result;
  } catch (error) {
    console.error('❌ Error in getWordsForTheme:', error);
    console.error('Stack trace:', error.stack);
    return [];
  }
}

/**
 * Get a single random word for a theme based on room settings
 * @param {number} themeId - Theme ID
 * @param {string} roomLanguage - Room language
 * @param {string} roomScript - Room script
 * @returns {Promise<string|null>} Random word text or null
 */
async function getRandomWordForTheme(themeId, roomLanguage, roomScript) {
  try {
    const words = await getWordsForTheme(themeId, roomLanguage, roomScript, 1);
    return words.length > 0 ? words[0] : null;
  } catch (error) {
    console.error('❌ Error in getRandomWordForTheme:', error);
    return null;
  }
}

module.exports = {
  getWordsForTheme,
  getRandomWordForTheme
};

