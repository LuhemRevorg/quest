# Fixtures

Saved HTML and HAR captures from real Quest pages, used as the input to parser
tests. The point: when Quest changes its markup, a test goes red instead of a
grade silently coming back wrong. (A prior community GPA tool died exactly this
way on a transcript revamp.)

```
html/   one .html per page we parse, named <page>.<yyyy-mm-dd>.html
har/    ICAJAX postback captures, named <task>.sanitized.har
```

Currently committed. The three sign-in pages are unauthenticated captures carrying
no cookies or personal data. The grades page came from a real session and has been
scrubbed of every personal value — see the rules above.

| Fixture | What it pins | Source |
| ------- | ------------ | ------ |
| `html/adfs-signin.<date>.html` | the WatIAM sign-in form, and that "keep me signed in" stays disabled | unauthenticated |
| `html/peoplesoft-signin.<date>.html` | PeopleSoft's local fallback form | unauthenticated |
| `html/peoplesoft-sso-signin.<date>.html` | the post-Duo handoff page and its `getIdPLink()` anchor | unauthenticated |
| `html/grades-winter2026.sanitized.html` | the grades grid's field ids | **authenticated, fully scrubbed** |

Tests live in `worker/src/quest.test.ts`.

## Sanitizing is mandatory

A raw capture of your own session contains **live cookies** — including the Quest
session and the Duo device-trust cookie — plus your student number, address, and
fee account. `.gitignore` only whitelists `fixtures/har/*.sanitized.har`; nothing
gets committed until it has been through sanitization.

Before committing any fixture, strip:

- all `Cookie` / `Set-Cookie` headers and `Authorization` headers
- student ID / WatIAM userid → a fixed placeholder
- names, addresses, phone numbers, email
- `ICSID` / `ICStateNum` values are fine to keep (they are per-session nonces,
  useless later) but the surrounding page must still be scrubbed

**Replace the record too, not just the identifiers.** Course codes, descriptions,
grades, grade points and academic standing all get swapped for placeholders. The
tests assert on element ids and structure — that is the part with regression value,
so keeping real marks buys nothing and puts an academic record in git history,
where it is effectively permanent.

Keep: markup structure, element ids, class names, column headers, term labels,
units, and grading-basis strings. Those are what break when Quest changes.
