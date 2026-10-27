import pytest

from czar_redact.redactor import Redactor


@pytest.fixture(scope="session")
def redactor() -> Redactor:
    return Redactor()
