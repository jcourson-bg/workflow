---
"@workflow/world-postgres": patch
---

Remove `@workflow/world-local` dependency from postgres world queue; invoke handlers directly within graphile-worker tasks instead of routing through the local world's HTTP executor layer
