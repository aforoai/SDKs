"""String lengths as the ingestor counts them.

The ingestor is Java: ``@Size(max = n)`` counts ``String.length()``, i.e. UTF-16
code units. A character outside the Basic Multilingual Plane (most emoji) is
two units. Python's ``len()`` counts code points, so it under-counts those.
"""

from __future__ import annotations


def utf16_length(text: str) -> int:
    """Length of ``text`` in UTF-16 code units."""
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in text)


def truncate_utf16(text: str, limit: int) -> str:
    """Longest prefix of ``text`` that is at most ``limit`` UTF-16 code units.

    Cuts between characters, so a surrogate pair is never split.
    """
    if len(text) * 2 <= limit:
        return text
    units = 0
    for index, ch in enumerate(text):
        units += 2 if ord(ch) > 0xFFFF else 1
        if units > limit:
            return text[:index]
    return text


def too_long(field: str, value: object, limit: int) -> "str | None":
    """Message naming the field and limit when ``value`` is over it, else None."""
    if value is None:
        return None
    text = str(value)
    length = utf16_length(text)
    if length <= limit:
        return None
    return (
        f"{field} is {length} characters (UTF-16 units), exceeding the ingestor's "
        f'{limit}-character limit (value starts "{text[:80]}")'
    )
