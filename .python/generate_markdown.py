"""Generate ten-language README and CHANGELOG files from JSON and templates.

Run with Python 3.10+: python .python/generate_markdown.py [--check]
The check mode validates sources and generated files without writing anything.
Only the Python standard library is required.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any

LANGUAGE_CODES = ["zh-Hans", "zh-Hant-HK", "zh-Hant-TW", "en", "fr", "es", "ja", "ko", "ru", "ar"]
LANGUAGE_CODE_DEFAULT = "zh-Hans"
CHANGELOG_CATEGORIES = ["hint", "feature", "fix", "improvement", "dependency"]
TEMPLATE_PATTERN = re.compile(r"\{\{\s*([A-Za-z0-9_$.-]+)\s*\}\}")
EXTRA_NON_ASCII = re.compile("[\u2190-\u21ff\u3000\uff01-\uff65]")
PLACEHOLDER_MARKERS = ("TODO_TRANSLATION", "TRANSLATION_PENDING", "MACHINE_TRANSLATION_PLACEHOLDER")
ROOT = Path(__file__).resolve().parents[1]


class MarkdownGenerationError(Exception):
    """Sources or generated documents are inconsistent."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise MarkdownGenerationError(message)


def validate_text(text: str, location: str) -> None:
    for marker in PLACEHOLDER_MARKERS:
        require(marker not in text, f"Translation placeholder {marker!r} in {location}")
    for char in text:
        if ord(char) > 127 and char != "\u00b7":
            require(
                not (unicodedata.category(char).startswith("P") or EXTRA_NON_ASCII.fullmatch(char)),
                f"Non-ASCII punctuation U+{ord(char):04X} in {location}",
            )


def load_text(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    validate_text(text, str(path))
    return text


def reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        require(key not in result, f"Duplicate JSON key: {key!r}")
        result[key] = value
    return result


def validate_strings(value: Any, location: str) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            validate_text(key, location)
            validate_strings(item, f"{location}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            validate_strings(item, f"{location}[{index}]")
    elif isinstance(value, str):
        require(bool(value.strip()), f"Empty text in {location}")
        validate_text(value, location)


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(load_text(path), object_pairs_hook=reject_duplicate_pairs)
        require(isinstance(data, dict), "JSON root must be an object")
        validate_strings(data, str(path))
        return data
    except (ValueError, MarkdownGenerationError) as error:
        raise MarkdownGenerationError(f"{path}: {error}") from None


def shape(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: shape(item) for key, item in value.items()}
    if isinstance(value, list):
        return [shape(item) for item in value]
    require(isinstance(value, str), "Language values must be strings, lists, or objects")
    return "text"


def validate_parity(sources: dict[str, dict[str, Any]], kind: str) -> None:
    reference = shape(sources[LANGUAGE_CODE_DEFAULT])
    for code, content in sources.items():
        require(shape(content) == reference, f"{kind} {code}: keys, types, or list lengths differ from {LANGUAGE_CODE_DEFAULT}")


def load_locales(root: Path, directory: str) -> dict[str, dict[str, Any]]:
    folder = root / directory
    expected = {f"lang_{code}.json" for code in LANGUAGE_CODES}
    actual = {path.name for path in folder.glob("lang_*.json")}
    require(actual == expected, f"{directory} language files: missing={sorted(expected - actual)}, extra={sorted(actual - expected)}")
    sources = {code: load_json(folder / f"lang_{code}.json") for code in LANGUAGE_CODES}
    validate_parity(sources, directory)
    return sources


def render_template(template: str, values: dict[str, Any]) -> str:
    def replace(match: re.Match[str]) -> str:
        key = match.group(1).strip()
        require(key in values, f"Missing template value: {key}")
        require(isinstance(values[key], str), f"Template value {key} must be text")
        return values[key]

    return TEMPLATE_PATTERN.sub(replace, template)


def resolve_values(values: dict[str, Any]) -> dict[str, Any]:
    """Resolve shared values and translations, rejecting missing or cyclic references."""
    resolved: dict[str, Any] = {}

    def resolve_key(key: str, trail: tuple[str, ...]) -> Any:
        require(key in values, f"Missing template value: {key}")
        require(key not in trail, f"Cyclic template value: {' -> '.join((*trail, key))}")
        if key not in resolved:
            resolved[key] = resolve(values[key], (*trail, key))
        return resolved[key]

    def resolve(value: Any, trail: tuple[str, ...]) -> Any:
        if isinstance(value, dict):
            return {key: resolve(item, trail) for key, item in value.items()}
        if isinstance(value, list):
            return [resolve(item, trail) for item in value]
        require(isinstance(value, str), "Template values must be strings, lists, or objects")

        def replace(match: re.Match[str]) -> str:
            replacement = resolve_key(match.group(1).strip(), trail)
            require(isinstance(replacement, str), f"Template reference {match.group(1)} must be text")
            return replacement

        output = TEMPLATE_PATTERN.sub(replace, value)
        require("{{" not in output and "}}" not in output, f"Unresolved placeholder in {'.'.join(trail)}")
        return output

    for key in values:
        resolve_key(key, ())
    return resolved


def validate_changelogs(changelogs, config, root):
    reference = changelogs[LANGUAGE_CODE_DEFAULT]["$data"]
    require(isinstance(reference, dict) and bool(reference), "Changelog history must not be empty")
    if config["versioned"]:
        package = json.loads((root / "package.json").read_text(encoding="utf-8"))
        require(next(iter(reference)) == "v" + package["version"], "Newest changelog version differs from package.json")
    for code, content in changelogs.items():
        require(set(content) == {"labels", "$data"}, f"Changelog {code}: expected labels and $data")
        require(list(content["$data"]) == list(reference), f"Changelog {code}: release order differs")
        for version, entry in content["$data"].items():
            require(set(entry) == {"released_date", "entries"}, f"Changelog {code} {version}: invalid fields")
            require(entry["released_date"] == reference[version]["released_date"], f"Changelog {code} {version}: date differs")
            require(re.fullmatch(r"\d{4}/\d{2}/\d{2}", entry["released_date"]) is not None, f"Invalid release date: {version}")
            datetime.strptime(entry["released_date"], "%Y/%m/%d")
            require(isinstance(entry["entries"], list) and bool(entry["entries"]), f"Empty release: {version}")
            for item in entry["entries"]:
                require(set(item) in ({"heading"}, {"category", "text"}), f"Invalid changelog item: {version}")
                if "category" in item:
                    require(item["category"] in content["labels"], f"Unknown changelog category: {item['category']}")
        for version, entry in reference.items():
            for expected, actual in zip(entry["entries"], content["$data"][version]["entries"]):
                require(expected.get("category") == actual.get("category"), f"Changelog {code} {version}: category differs")


def language_list(code, languages, directory, prefix):
    lines = []
    for target in LANGUAGE_CODES:
        language = languages[target]
        label = f"{language['$name']} [{target}]"
        if target == code:
            lines.append(f"- {label} # {language['text_current_lowercase']}")
        else:
            lines.append(f"- [{label}]({language['repo_url']}/blob/{language['repo_branch']}/{directory}/{prefix}-{target}.md)")
    return "\n".join(lines)


def release_history(changelog, level=1, limit=None):
    chunks = []
    for version, entry in list(changelog["$data"].items())[:limit]:
        lines = ["#" * level + " " + version, "", "###### " + entry["released_date"], ""]
        for item in entry["entries"]:
            if "heading" in item:
                lines.extend(["##### " + item["heading"], ""])
            else:
                lines.append(f"* `{changelog['labels'][item['category']]}` {item['text']}")
        chunks.append("\n".join(lines).rstrip())
    return "\n\n".join(chunks)


def build_artifacts(root):
    config = json.loads((root / ".python/docs_config.json").read_text(encoding="utf-8"))
    require(isinstance(config.get("versioned"), bool), "versioned must be a boolean")
    require(isinstance(config.get("changelog_aliases"), dict), "changelog_aliases must be an object")
    require(all(code in LANGUAGE_CODES for code in config["changelog_aliases"].values()), "Unsupported changelog alias language")
    common = load_json(root / ".readme/common.json")
    languages = load_locales(root, ".readme")
    changelogs = load_locales(root, ".changelog")
    validate_changelogs(changelogs, config, root)
    for code, content in languages.items():
        require(not set(common) & set(content), f"README {code}: localized keys override common values")
        languages[code] = resolve_values({**common, **content})
        changelogs[code] = resolve_values(changelogs[code])
    readme_template = load_text(root / ".readme/template_readme.md")
    changelog_template = load_text(root / ".changelog/template_changelog.md")
    artifacts = {}
    for code, content in languages.items():
        values = dict(content)
        values["placeholder_languages"] = language_list(code, languages, ".readme", "README")
        values["placeholder_recent_history"] = release_history(changelogs[code], 3, 3)
        values["changelog_url"] = f"{content['repo_url']}/blob/{content['repo_branch']}/.changelog/CHANGELOG-{code}.md"
        readme = render_template(readme_template, values)
        artifacts[root / f".readme/README-{code}.md"] = readme
        if code == LANGUAGE_CODE_DEFAULT:
            artifacts[root / "README.md"] = readme
        values["placeholder_languages"] = language_list(code, languages, ".changelog", "CHANGELOG")
        values["placeholder_release_history"] = release_history(changelogs[code])
        changelog = render_template(changelog_template, values)
        artifacts[root / f".changelog/CHANGELOG-{code}.md"] = changelog
        for alias, language in config["changelog_aliases"].items():
            require(alias in {"docs/CHANGELOG.md", "assets/docs/CHANGELOG.md"}, f"Unsupported changelog alias: {alias}")
            if language == code:
                artifacts[root / alias] = changelog
    for path, output in artifacts.items():
        validate_text(output, str(path))
        require("{{" not in output and "}}" not in output, f"Unresolved placeholder in {path}")
    return artifacts


def generated_inventory(root: Path) -> set[Path]:
    patterns = ("README.md", "README-*.md", "CHANGELOG.md", "CHANGELOG-*.md", ".readme/README-*.md", ".changelog/CHANGELOG-*.md", "docs/CHANGELOG*.md", "assets/docs/CHANGELOG*.md")
    return {path for pattern in patterns for path in root.glob(pattern)}


def process_artifacts(root: Path, artifacts: dict[Path, str], check: bool) -> None:
    orphans = sorted(generated_inventory(root) - artifacts.keys())
    require(not orphans, "Orphan generated files: " + ", ".join(str(path.relative_to(root)) for path in orphans))
    if check:
        drift = []
        for path, expected in artifacts.items():
            if not path.is_file():
                drift.append(f"missing: {path.relative_to(root)}")
            elif path.read_text(encoding="utf-8") != expected:
                drift.append(f"stale: {path.relative_to(root)}")
        require(not drift, "Generated documentation is out of sync: " + "; ".join(drift))
    else:
        for path, output in artifacts.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(output, encoding="utf-8", newline="\n")
            print(f"Generated {path.relative_to(root)}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate sources and artifacts without writing")
    args = parser.parse_args(argv)
    try:
        artifacts = build_artifacts(ROOT)
        process_artifacts(ROOT, artifacts, args.check)
    except (MarkdownGenerationError, OSError, UnicodeError, KeyError, TypeError, ValueError) as error:
        print(f"MARKDOWN_ERROR {error}", file=sys.stderr)
        return 1
    print(f"MARKDOWN_OK languages={len(LANGUAGE_CODES)} artifacts={len(artifacts)} mode={'check' if args.check else 'write'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
