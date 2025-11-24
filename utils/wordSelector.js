const { Keyword, Translation, Language, Theme } = require("../models");
const { Op } = require("sequelize");

/**
 * Get words for a theme based on room's language and script settings
 * @param {number} themeId - Theme ID
 * @param {string} roomLanguage - Room language (EN, TE, HI) or language code (en, te, hi)
 * @param {string} roomScript - Room script ('english' or 'default')
 * @param {number} limit - Optional limit for random words
 * @returns {Promise<Array<string>>} Array of word texts
 */
async function getWordsForTheme(themeId, roomLanguage, roomScript, limit = 3) {
  try {
    console.log(
      `🔍 getWordsForTheme: themeId=${themeId}, language=${roomLanguage}, script=${roomScript}, limit=${limit}`,
    );

    // --- 1. NORMALIZATION ---
    const langCodeMap = {
      EN: "en",
      TE: "te",
      HI: "hi",
      English: "en",
      english: "en",
      Hindi: "hi",
      hindi: "hi",
      Telugu: "te",
      telugu: "te",
      Kannada: "kn",
      kannada: "kn",
      Marathi: "mr",
      marathi: "mr",
    };
    const normalizedLangCode =
      langCodeMap[roomLanguage] ||
      langCodeMap[roomLanguage?.toLowerCase()] ||
      roomLanguage?.toLowerCase() ||
      "en";

    let normalizedScript = (roomScript || "default").toLowerCase();
    if (
      normalizedScript === "roman" ||
      normalizedScript === "native" ||
      normalizedScript === "all"
    ) {
      normalizedScript =
        normalizedScript === "roman" || normalizedScript === "english"
          ? "english"
          : "default";
    }

    // --- 2. TARGET DETERMINATION ---
    let targetLanguageCode = normalizedLangCode;
    let targetScriptType = "roman";

    if (normalizedLangCode === "en") {
      targetLanguageCode = "en";
      targetScriptType = "roman";
    } else if (normalizedScript === "english") {
      targetLanguageCode = "en";
      targetScriptType = "roman";
    } else if (normalizedScript === "default") {
      targetLanguageCode = normalizedLangCode;
      targetScriptType = "roman";
    }

    console.log(
      `    🎯 Target: language=${targetLanguageCode}, script=${targetScriptType}`,
    );

    // --- 3. FETCH DATA ---

    // Use deep include to fetch Theme -> Keywords -> Translations -> Language
    const theme = await Theme.findByPk(themeId, {
      include: [
        {
          model: Keyword,
          as: "keywords", // MUST match the alias in Theme.hasMany(Keyword, { as: 'keywords' })
          include: [
            {
              model: Translation,
              as: "translations", // MUST match the alias in Keyword.hasMany(Translation, { as: 'translations' })
              include: [
                {
                  model: Language,
                  as: "language", // MUST match the alias in Translation.belongsTo(Language, { as: 'language' })
                },
              ],
            },
          ],
        },
      ],
    });

    // CHECK FOR NULL/EMPTY KEYWORDS ARRAY
    if (!theme || !theme.keywords || theme.keywords.length === 0) {
      console.log(`    ⚠️ No keywords found for theme ${themeId}`);
      // Log the theme itself to debug if the association is loading data
      // console.log(`Theme data:`, theme);
      return [];
    }

    console.log(`    Found ${theme.keywords.length} keywords in theme`);

    // Get the Language object for the calculated target language
    let targetLanguage = await Language.findOne({
      where: { languageCode: targetLanguageCode },
    });

    // Get the English Language object for final fallback
    const englishLanguage = await Language.findOne({
      where: { languageCode: "en" },
    });

    if (!targetLanguage) {
      console.log(
        `    ⚠️ Target Language not found: ${targetLanguageCode}, using English fallback.`,
      );
      targetLanguage = englishLanguage;
      targetLanguageCode = "en";
      targetScriptType = "roman";
    }
    if (!englishLanguage) {
      console.log(
        `    ❌ English language (en) not found in database! Cannot guarantee fallback.`,
      );
      return [];
    }

    console.log(
      `    Using target language: ${targetLanguage.languageName} (${targetLanguage.languageCode})`,
    );

    // --- 4. EXTRACT AND FALLBACK LOGIC ---

    const words = [];
    for (const keyword of theme.keywords) {
      let finalTranslation = null;

      // --- 4a. PRIORITY 1: Check the determined target language and script ---
      finalTranslation = keyword.translations?.find(
        (t) =>
          t.languageId === targetLanguage.id &&
          t.scriptType === targetScriptType,
      );

      if (finalTranslation) {
        words.push(finalTranslation.translatedText);
        // console.log(`    ✅ Found primary translation for "${keyword.keyName}": ${finalTranslation.translatedText}`);
        continue;
      }

      // --- 4b. PRIORITY 2: Fallback to the OTHER script in the same language ---
      if (targetLanguage.languageCode !== "en") {
        const fallbackScript =
          targetScriptType === "roman" ? "native" : "roman";

        finalTranslation = keyword.translations?.find(
          (t) =>
            t.languageId === targetLanguage.id &&
            t.scriptType === fallbackScript,
        );

        if (finalTranslation) {
          words.push(finalTranslation.translatedText);
          // console.log(`    ⚠️ Found fallback script (${fallbackScript}) for "${keyword.keyName}": ${finalTranslation.translatedText}`);
          continue;
        }
      }

      // --- 4c. PRIORITY 3: GUARANTEED FALLBACK TO ENGLISH ROMAN ---

      finalTranslation = keyword.translations?.find(
        (t) => t.languageId === englishLanguage.id && t.scriptType === "roman",
      );

      if (finalTranslation) {
        words.push(finalTranslation.translatedText);
        // console.log(`    ⚠️ Universal fallback to English Roman for "${keyword.keyName}": ${finalTranslation.translatedText}`);
      } else {
        console.log(
          `    ❌ CRITICAL: Could not find English Roman translation for "${keyword.keyName}". Skipping.`,
        );
      }
    }

    console.log(`    Found ${words.length} words after filtering`);

    // Shuffle and limit if needed
    const shuffled = words.sort(() => 0.5 - Math.random());
    const result = limit ? shuffled.slice(0, limit) : shuffled;

    console.log(
      `    Returning ${result.length} words${limit ? ` (limited to ${limit})` : ""}`,
    );

    return result;
  } catch (error) {
    console.error("❌ Error in getWordsForTheme:", error);
    console.error("Stack trace:", error.stack);
    return [];
  }
}

async function getRandomWordForTheme(themeId, roomLanguage, roomScript) {
  try {
    const words = await getWordsForTheme(themeId, roomLanguage, roomScript, 3);
    return words.length > 0 ? words[0] : null;
  } catch (error) {
    console.error("❌ Error in getRandomWordForTheme:", error);
    return null;
  }
}

module.exports = {
  getWordsForTheme,
  getRandomWordForTheme,
};
