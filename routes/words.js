const express = require("express");
const router = express.Router();
const { Theme, Language, Word } = require("../models");

router.post("/add-words", async (req, res) => {
  try {
    const { words } = req.body;

    if (!Array.isArray(words) || words.length === 0) {
      return res.status(400).json({ error: "words array required" });
    }

    // Load all languages from DB
    const languages = await Language.findAll();

    // Build map: { English: "en", Hindi: "hi" }
    const langMap = {};
    languages.forEach(lang => {
      langMap[lang.languageName.toLowerCase()] = lang.languageCode;
    });

    const hasLanguages = Object.keys(langMap).length > 0;

    const bulkInsert = [];

    for (const item of words) {
      const { theme } = item;
      if (!theme) continue;

      // Find/create themeId
      const themeRow = await Theme.findOrCreate({
        where: { title: theme },
        defaults: { title: theme }
      });

      const themeId = themeRow[0].id;

      // CASE A — Database has languages → use them
      if (hasLanguages) {
        for (const key of Object.keys(item)) {
          if (key === "theme") continue;

          const langName = key.toLowerCase();
          const dbLang = langMap[langName]; // languageCode from DB

          if (!dbLang) continue; // Skip languages not in DB
          if (!item[key]) continue;

          bulkInsert.push({
            themeId,
            languageCode: dbLang,
            text: item[key]
          });
        }
      } 
      // CASE B — No languages in database → English only
      else {
        if (!item.English) continue;

        bulkInsert.push({
          themeId,
          languageCode: "en",
          text: item.English
        });
      }
    }

    // Insert all at once
    await Word.bulkCreate(bulkInsert);

    res.json({
      success: true,
      inserted: bulkInsert.length
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
});

router.get("/schema", async (req, res) => {
  try {
    // Fetch all languages
    const languages = await Language.findAll({
      attributes: ["languageName", "languageCode"]
    });

    // Fetch all themes
    const themes = await Theme.findAll({
      attributes: ["title"]
    });

    const languageList = languages.map(l => ({
      name: l.languageName,
      code: l.languageCode
    }));

    const themeList = themes.map(t => t.title);

    // Determine primary structure
    const hasLanguages = languageList.length > 0;

    // Build example word object
    const exampleWord = {
      theme: themeList.length > 0 ? themeList[0] : "exampleTheme"
    };

    if (hasLanguages) {
      // Add all languages as keys with placeholder text
      languageList.forEach(lang => {
        exampleWord[lang.name] = `<${lang.name} word>`;
      });
    } else {
      // Only English required
      exampleWord["English"] = "<English word>";
    }

    // Full schema definition
    const schema = {
      description:
        "Use this schema to send words to /add-words. Each language field is optional unless English-only mode.",
      themeRequired: true,
      languagesRequired: hasLanguages ? languageList.map(l => l.name) : ["English"],
      structureExample: {
        words: [exampleWord]
      }
    };

    res.json({
      success: true,
      languages: languageList,
      themes: themeList,
      schema
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      error: "Internal Server Error",
      details: error.message
    });
  }
});



module.exports = router;
