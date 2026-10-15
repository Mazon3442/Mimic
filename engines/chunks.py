"""Split a script into sentences, for engines that stop after the first one or two.

Shared by the workers (each runs from its own venv, but this folder is on sys.path).
"""
import re

# A sentence ends at . ! ? or … (optionally followed by a closing quote or bracket) and then a space.
_END = re.compile(r"(?<=[.!?…])\s+|(?<=[.!?…][\"'”’)\]])\s+")
GAP_SECONDS = 0.18  # breath between sentences when they're joined back together


def sentences(text, min_chars=2):
    parts = [p.strip() for p in _END.split(text.strip()) if p.strip()]
    # Glue fragments that are only punctuation or a stray tag onto the previous sentence.
    out = []
    for p in parts:
        if out and len(re.sub(r"[\W_]", "", p)) < min_chars:
            out[-1] = f"{out[-1]} {p}"
        else:
            out.append(p)
    return out or [text.strip()]
