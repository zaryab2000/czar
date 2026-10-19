"""PII corpus (T-064, CZ-26 §14): emails, phones and names with contact details become [[R:P:…]] markers."""

import re

import pytest

from czar_redact.redactor import Redactor, UnsupportedLanguageError

MARKER = re.compile(r"\[\[R:P:[A-Z][A-Z0-9_]*#[1-9][0-9]*\]\]")

# Invented people and contact details; none belongs to a real person.
CORPUS = [
    ("Email the draft to maria.lopez@example.com before Friday.", ["maria.lopez@example.com"], "EMAIL_ADDRESS"),
    ("Call me on +1 415-555-0142 when the build is green.", ["415-555-0142"], "PHONE_NUMBER"),
    ("Ask Jonathan Whitaker (jwhitaker@example.org) to review it.", ["Jonathan Whitaker", "jwhitaker@example.org"], "PERSON"),
    ("Priya Raman's number is 212-555-0199.", ["Priya Raman", "212-555-0199"], "PERSON"),
    ("Contact Sarah Connor at sarah.connor@example.net or (650) 555-0123.", ["Sarah Connor", "sarah.connor@example.net", "555-0123"], "PERSON"),
]


@pytest.mark.parametrize(("text", "secrets", "entity"), CORPUS)
def test_pii_is_replaced_with_markers(redactor: Redactor, text: str, secrets: list[str], entity: str) -> None:
    result = redactor.redact(text, "en")
    for secret in secrets:
        assert secret not in result.text
    assert MARKER.search(result.text)
    assert entity in {item["type"] for item in result.entities}


def test_counter_distinguishes_values_and_repeats_the_same_value(redactor: Redactor) -> None:
    text = "Write to ana@example.com, then to ben@example.com, then ana@example.com again."
    result = redactor.redact(text, "en")
    assert result.text.count("[[R:P:EMAIL_ADDRESS#1]]") == 2
    assert result.text.count("[[R:P:EMAIL_ADDRESS#2]]") == 1


def test_clean_text_is_unchanged(redactor: Redactor) -> None:
    text = "Refactor the payment router and rerun the tests."
    result = redactor.redact(text, "en")
    assert result.text == text
    assert result.entities == []


def test_existing_secret_markers_survive(redactor: Redactor) -> None:
    text = "Token [[R:S:generic-api-key]] belongs to lee@example.com"
    result = redactor.redact(text, "en")
    assert "[[R:S:generic-api-key]]" in result.text
    assert "lee@example.com" not in result.text


def test_only_english_is_supported(redactor: Redactor) -> None:
    with pytest.raises(UnsupportedLanguageError):
        redactor.redact("Bonjour Marie", "fr")
