```json plan-inventory
{
  "repos": [
    {
      "repo": "acme/api",
      "has": [
        "A REST API over SQLite"
      ],
      "gaps": [
        "No retention job",
        "No audit log"
      ],
      "evidence": [
        {
          "kind": "file",
          "ref": "server/src/db.js:129",
          "note": "the work_item table"
        }
      ]
    },
    {
      "repo": "acme/web",
      "has": [
        "A React board"
      ],
      "gaps": [
        "No export button"
      ],
      "evidence": [
        {
          "kind": "file",
          "ref": "ui/src/Board.jsx:12",
          "note": "the board"
        }
      ]
    }
  ],
  "key_facts": []
}
```
