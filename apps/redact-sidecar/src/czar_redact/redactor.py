"""Presidio analyze + anonymize with Czar markers (CZ-26 §4, 02 §3.1).

Each detected entity is replaced with ``[[R:P:<ENTITY>#n]]``. ``n`` counts distinct values of one entity
type within one text (``redaction.markerCounterScope`` = per text), so the same value keeps its number
and two different values stay distinguishable. Markers are never reversible: nothing maps them back.
"""

from __future__ import annotations

from dataclasses import dataclass

from presidio_analyzer import AnalyzerEngine, RecognizerResult
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

SUPPORTED_LANGUAGES = ("en",)  # redaction.languages default (C2-04)
# spaCy pipeline bundled with the helper. `md` keeps RSS within CZ-26 §13's 400 MB; `lg` measured 807 MB.
SPACY_MODEL = "en_core_web_md"


def default_analyzer() -> AnalyzerEngine:
    provider = NlpEngineProvider(
        nlp_configuration={"nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": SPACY_MODEL}]}
    )
    return AnalyzerEngine(nlp_engine=provider.create_engine(), supported_languages=list(SUPPORTED_LANGUAGES))


class UnsupportedLanguageError(ValueError):
    """Raised for text the helper cannot screen; the daemon then uses the regex fallback with forced review."""


@dataclass(frozen=True)
class Redaction:
    text: str
    entities: list[dict[str, object]]


def marker(entity: str, n: int) -> str:
    return f"[[R:P:{entity}#{n}]]"


class Redactor:
    def __init__(self, analyzer: AnalyzerEngine | None = None, anonymizer: AnonymizerEngine | None = None) -> None:
        self._analyzer = analyzer or default_analyzer()
        self._anonymizer = anonymizer or AnonymizerEngine()

    def redact(self, text: str, language: str, entities: list[str] | None = None) -> Redaction:
        if language not in SUPPORTED_LANGUAGES:
            raise UnsupportedLanguageError(language)
        results: list[RecognizerResult] = self._analyzer.analyze(text=text, language=language, entities=entities)
        if not results:
            return Redaction(text=text, entities=[])

        counters: dict[str, dict[str, int]] = {}
        for result in sorted(results, key=lambda r: (r.start, -r.end)):
            values = counters.setdefault(result.entity_type, {})
            values.setdefault(text[result.start : result.end], len(values) + 1)

        def operator_for(entity_type: str) -> OperatorConfig:
            values = counters.get(entity_type, {})
            return OperatorConfig("custom", {"lambda": lambda value: marker(entity_type, values.get(value, 1))})

        anonymized = self._anonymizer.anonymize(
            text=text,
            analyzer_results=results,
            operators={entity_type: operator_for(entity_type) for entity_type in counters},
        )
        counts: dict[str, int] = {}
        for item in anonymized.items:
            counts[item.entity_type] = counts.get(item.entity_type, 0) + 1
        return Redaction(
            text=anonymized.text,
            entities=[{"type": entity_type, "count": count} for entity_type, count in sorted(counts.items())],
        )
