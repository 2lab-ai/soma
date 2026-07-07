---
name: linear
description: |
  Use Symphony's `linear_graphql` tool for raw Linear GraphQL operations such as
  issue reads, state changes, workpad comment updates, and attachment lookups.
---

# Linear GraphQL

Use this skill during Symphony app-server sessions when `linear_graphql` is available.

## Tool contract

Send one GraphQL operation per call:

```json
{
  "query": "query or mutation document",
  "variables": {
    "optional": "graphql variables object"
  }
}
```

Treat a top-level `errors` array as a failed operation even if the tool call itself succeeds.

## Common queries

### Issue by key

```graphql
query IssueByKey($key: String!) {
  issue(id: $key) {
    id
    identifier
    title
    url
    description
    branchName
    state {
      id
      name
      type
    }
    project {
      id
      name
    }
    labels {
      nodes {
        id
        name
      }
    }
  }
}
```

### Team states for an issue

```graphql
query IssueTeamStates($id: String!) {
  issue(id: $id) {
    id
    team {
      id
      key
      name
      states {
        nodes {
          id
          name
          type
        }
      }
    }
  }
}
```

### Active comments

```graphql
query IssueComments($id: String!) {
  issue(id: $id) {
    comments(first: 50) {
      nodes {
        id
        body
        createdAt
        updatedAt
        resolvedAt
      }
    }
  }
}
```

## Common mutations

### Update issue state

```graphql
mutation UpdateIssueState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
    issue {
      id
      identifier
      state {
        id
        name
      }
    }
  }
}
```

### Create comment

```graphql
mutation CreateComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment {
      id
      body
    }
  }
}
```

### Edit comment

```graphql
mutation UpdateComment($id: String!, $body: String!) {
  commentUpdate(id: $id, input: { body: $body }) {
    success
    comment {
      id
      body
    }
  }
}
```
