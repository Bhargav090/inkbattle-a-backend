const express = require("express");
const router = express.Router();
// Ensure Keyword, Theme, and Language models are correctly imported
const { Theme, Language, Keyword, Translation } = require("../models");
router.post("/add-words", async (req, res) => {
  try {
    const { words } = req.body;

    if (!Array.isArray(words) || words.length === 0) {
      return res.status(400).json({ error: "words array required" });
    }

    // Load all languages
    const languages = await Language.findAll();
    const langCodeToId = {};
    languages.forEach((l) => {
      langCodeToId[l.languageCode] = l.id;
    });

    const englishId = langCodeToId["en"];
    if (!englishId)
      return res.status(500).json({ error: "English not found in DB!" });

    // Insert keywords + translations
    for (const item of words) {
      const { theme } = item;
      if (!theme) continue;

      // Find or create theme
      const [themeRow] = await Theme.findOrCreate({
        where: { title: theme },
      });

      const themeId = themeRow.id;

      // Loop over provided languages
      for (const langName of Object.keys(item)) {
        if (langName === "theme") continue;

        const text = item[langName];
        if (!text) continue;

        // convert "English" => "en"
        const language = languages.find(
          (l) => l.languageName.toLowerCase() === langName.toLowerCase(),
        );

        if (!language) continue;

        // 1. Create Keyword entry
        const keyword = await Keyword.create({
          themeId,
          category: theme,
          keyName: text,
          languageCode: language.languageCode,
        });

        // 2. Create Translation entry (roman only)
        await Translation.create({
          keywordId: keyword.id,
          languageId: language.id,
          scriptType: "roman",
          translatedText: text,
        });
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Internal Server Error", details: err.message });
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
