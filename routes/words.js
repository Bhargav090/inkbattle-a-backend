const express = require("express");
const router = express.Router();
// Ensure Keyword, Theme, and Language models are correctly imported
const { Theme, Language, Keyword, Translation } = require("../models");

// Helper function to process language and script data
function getTranslationDetails(langData) {
    if (typeof langData === 'string') {
        // Old structure fallback (single string for English)
        return {
            roman: langData,
            native: null, // No native script provided
        };
    } else if (typeof langData === 'object' && langData !== null) {
        // New structure: { "default": <native>, "english": <roman> }
        return {
            roman: langData.english,
            native: langData.default,
        };
    }
    return { roman: null, native: null };
}

router.post("/add-words", async (req, res) => {
    try {
        const { words } = req.body;

        if (!Array.isArray(words) || words.length === 0) {
            return res.status(400).json({ error: "words array required" });
        }

        // --- PRE-PROCESSING: Load all necessary data ---
        const languages = await Language.findAll();
        const langMap = {}; // Map languageName to object
        const langNameToId = {}; // Map languageName to ID
        languages.forEach((l) => {
            langMap[l.languageName.toLowerCase()] = l;
            langNameToId[l.languageName.toLowerCase()] = l.id;
        });

        // The input requires an English translation, which serves as the base "keyName"
        const englishLang = langMap["english"];
        if (!englishLang) {
            return res.status(500).json({ error: "English not found in DB!" });
        }
        
        const results = [];
        const missingTranslations = []; // To collect warnings for the response

        // --- CORE LOGIC: Process each keyword item ---
        for (const item of words) {
            const { theme } = item;
            const englishKeywordText = item.english;

            if (!theme || !englishKeywordText) {
                // Skip or warn if theme or base English word is missing
                if (Object.keys(item).length > 0) {
                    results.push({
                        item: item,
                        status: "skipped",
                        reason: "Missing 'theme' or base 'english' keyword.",
                    });
                }
                continue;
            }

            // 1. Find or create Theme
            const [themeRow] = await Theme.findOrCreate({
                where: { title: theme },
            });
            const themeId = themeRow.id;

            // 2. Create the BASE Keyword entry (using the English word as the keyName)
            
            const [baseKeyword, created] = await Keyword.findOrCreate({
                where: { 
                    keyName: englishKeywordText, 
                    languageCode: englishLang.languageCode, 
                    themeId: themeId 
                },
                defaults: {
                    themeId,
                    category: theme,
                    keyName: englishKeywordText,
                    languageCode: englishLang.languageCode,
                }
            });
            
            const keywordId = baseKeyword.id;
            let successfulTranslations = 0;
            let currentMissingLangs = [];

            // 3. Loop over all available languages in the DB (for completeness check)
            for (const lang of languages) {
                const langNameLower = lang.languageName.toLowerCase();
                const langData = item[langNameLower];
                const translationDetails = getTranslationDetails(langData);

                const { roman, native } = translationDetails;

                // Check 1: Is the language data present in the input item?
                if (!langData) {
                    currentMissingLangs.push(lang.languageName);
                    continue; // Skip to the next language if not present
                }
                
                // Check 2: Process Romanized (Phonetic) Script
                if (roman) {
                    await Translation.findOrCreate({
                        where: {
                            keywordId: keywordId,
                            languageId: lang.id,
                            scriptType: "roman",
                        },
                        defaults: {
                            keywordId: keywordId,
                            languageId: lang.id,
                            scriptType: "roman",
                            translatedText: roman,
                        }
                    });
                    successfulTranslations++;
                }  

                // Check 3: Process Native (Default) Script
                if (native) {
                    await Translation.findOrCreate({
                        where: {
                            keywordId: keywordId,
                            languageId: lang.id,
                            scriptType: "native",
                        },
                        defaults: {
                            keywordId: keywordId,
                            languageId: lang.id,
                            scriptType: "native",
                            translatedText: native,
                        }
                    });
                    successfulTranslations++;
                }
            }

            // Report the outcome for this item
            results.push({
                keyword: englishKeywordText,
                theme: theme,
                translationsCount: successfulTranslations,
                missingLanguages: currentMissingLangs,
            });

            if (currentMissingLangs.length > 0) {
                missingTranslations.push({
                    keyword: englishKeywordText,
                    missing: currentMissingLangs,
                });
            }
        }

        res.json({ 
            success: true, 
            message: `${results.length} keywords processed.`,
            results: results,
            warnings: missingTranslations.length > 0 ? missingTranslations : undefined,
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ 
            error: "Internal Server Error", 
            details: err.message 
        });
    }
});
 

router.delete("/theme/:themeName", async (req, res) => {
  try {
    const { themeName } = req.params;
    
    // Find the theme
    const theme = await Theme.findOne({
      where: { title: themeName }
    });
    
    if (!theme) {
      return res.status(404).json({ 
        success: false, 
        message: `Theme "${themeName}" not found` 
      });
    }
    
    // Find all keywords for this theme
    const keywords = await Keyword.findAll({
      where: { themeId: theme.id }
    });
    
    const keywordIds = keywords.map(k => k.id);
    
    // Delete all translations for these keywords
    let deletedTranslations = 0;
    if (keywordIds.length > 0) {
      deletedTranslations = await Translation.destroy({
        where: { keywordId: keywordIds }
      });
    }
    
    // Delete all keywords
    const deletedKeywords = await Keyword.destroy({
      where: { themeId: theme.id }
    });
    
    res.json({
      success: true,
      message: `Deleted ${deletedKeywords} keywords and ${deletedTranslations} translations for theme "${themeName}"`,
      deletedKeywords,
      deletedTranslations
    });
  } catch (error) {
    console.error("Delete theme error:", error);
    res.status(500).json({
      success: false,
      error: "Internal Server Error",
      details: error.message
    });
  }
});

router.get("/schema", async (req, res) => {
  try {
    // Fetch all languages
    const languages = await Language.findAll({
      attributes: ["languageName", "languageCode"],
    });

    // Fetch all themes
    const themes = await Theme.findAll({
      attributes: ["title"],
    });

    const languageList = languages.map((l) => ({
      name: l.languageName,
      code: l.languageCode,
    }));

    const themeList = themes.map((t) => t.title);

    // Determine primary structure
    const hasLanguages = languageList.length > 0;

    // Build example keyword object
    const exampleKeyword = {
      theme: themeList.length > 0 ? themeList[0] : "exampleTheme",
    };

    if (hasLanguages) {
      // Add all languages as keys with placeholder text
      languageList.forEach((lang) => {
        exampleKeyword[lang.name] = `<${lang.name} keyword>`;
      });
    } else {
      // Only English required
      exampleKeyword["English"] = "<English keyword>";
    }

    // Full schema definition
    const schema = {
      description:
        "Use this schema to send keywords to /add-words. Each language field is optional unless English-only mode.",
      themeRequired: true,
      languagesRequired: hasLanguages
        ? languageList.map((l) => l.name)
        : ["English"],
      structureExample: {
        keywords: [exampleKeyword],
      },
    };

    res.json({
      success: true,
      languages: languageList,
      themes: themeList,
      schema,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      error: "Internal Server Error",
      details: error.message,
    });
  }
});

module.exports = router;
