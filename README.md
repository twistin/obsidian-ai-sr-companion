# Obsidian AI Spaced Repetition Companion

This is the companion plugin for the Zettelkasten AI Spaced Repetition Web App.

It integrates seamlessly with your Obsidian Vault, providing an embedded UI to review flashcards right inside your vault, while an external backend handles AI extraction and spaced repetition algorithms.

## Features
- **File-based Decks**: Every Markdown file equipped with `START/END` blocks or `::` tags is fully supported as a deck without proprietary databases.
- **In-Vault Review**: Access your due flashcards from the left sidebar via The Layer Viewer icon.
- **Frontmatter Metadata**: Reviewing a card intelligently updates the SM2 algorithm coordinates directly in your Markdown file's YAML header.

## Installation

### Manual Installation
1. Go to **Settings > Third-party plugins** in Obsidian and turn off Safe Mode.
2. Download `main.js`, `styles.css`, and `manifest.json` from the [Latest Release](https://github.com/sdcarr/obsidian-ai-sr-companion/releases) page.
3. Move the downloaded files to your vault's plugin folder: `.obsidian/plugins/obsidian-ai-sr-companion/`
4. Reload Obsidian and activate the plugin.

## AI Generation & Web Application
This plugin acts as the native bridge for **[TU_NOMBRE_PERSONAL Spaced Repetition App](https://github.com/TU_USUARIO/Obsidian-SR)**. 

To take full advantage of AI flashcard generation, dashboard analytics, and spaced repetition review algorithms, please visit the main Web App repository linked above and follow the quick installation guide.
