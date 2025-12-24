# Expense Sharing Backend

This backend is built for the expense-sharing assignment. It supports creating groups, adding shared expenses, tracking group-wise balances (who owes whom), and recording settlements.

It uses only Node.js built-in modules, so there is no dependency installation required.

## Features
- Create users and groups
- Add shared expenses inside a group
- Split types supported:
  - equal
  - exact
  - percentage
- Group balances are simplified (netted) to show who owes whom
- Record settlements to reduce outstanding balances
- Reset endpoint to clear data for demos

## Requirements
- Node.js 18+ (Node 24.x also works)

## How to Run
From the project directory:

Option 1:
```bash
node server.js
```

Option 2:
```bash
npm start
```

Server runs at:
http://localhost:5000

## Endpoints
- GET /health
- GET / (basic API info)
- POST /users
- GET /users
- POST /groups
- POST /expenses
- GET /groups/:groupId/balances
- GET /users/:userId/summary?groupId=...
- POST /settlements
- POST /admin/reset

## Example Usage (cURL)

### Create users
```bash
curl -X POST http://localhost:5000/users -H "Content-Type: application/json" -d "{\"name\":\"Alice\"}"
curl -X POST http://localhost:5000/users -H "Content-Type: application/json" -d "{\"name\":\"Bob\"}"
curl -X GET  http://localhost:5000/users
```

### Create a group
```bash
curl -X POST http://localhost:5000/groups -H "Content-Type: application/json" -d "{\"name\":\"Goa Trip\",\"members\":[\"<ALICE_ID>\",\"<BOB_ID>\"]}"
```

### Add expenses

Equal split
```bash
curl -X POST http://localhost:5000/expenses -H "Content-Type: application/json" -d "{
  \"groupId\":\"<GROUP_ID>\",
  \"paidBy\":\"<ALICE_ID>\",
  \"amount\":1200,
  \"description\":\"Dinner\",
  \"split\":{\"type\":\"equal\"}
}"
```

Exact split
```bash
curl -X POST http://localhost:5000/expenses -H "Content-Type: application/json" -d "{
  \"groupId\":\"<GROUP_ID>\",
  \"paidBy\":\"<ALICE_ID>\",
  \"amount\":1000,
  \"description\":\"Hotel\",
  \"participants\":[\"<ALICE_ID>\",\"<BOB_ID>\"],
  \"split\":{
    \"type\":\"exact\",
    \"values\":[
      {\"userId\":\"<ALICE_ID>\",\"amount\":400},
      {\"userId\":\"<BOB_ID>\",\"amount\":600}
    ]
  }
}"
```

Percentage split
```bash
curl -X POST http://localhost:5000/expenses -H "Content-Type: application/json" -d "{
  \"groupId\":\"<GROUP_ID>\",
  \"paidBy\":\"<ALICE_ID>\",
  \"amount\":500,
  \"description\":\"Taxi\",
  \"participants\":[\"<ALICE_ID>\",\"<BOB_ID>\"],
  \"split\":{
    \"type\":\"percentage\",
    \"values\":[
      {\"userId\":\"<ALICE_ID>\",\"percentage\":30},
      {\"userId\":\"<BOB_ID>\",\"percentage\":70}
    ]
  }
}"
```

### View simplified balances
```bash
curl http://localhost:5000/groups/<GROUP_ID>/balances
```

### View a user summary in a group
```bash
curl "http://localhost:5000/users/<ALICE_ID>/summary?groupId=<GROUP_ID>"
```

### Settle dues
Check balances first, then settle in the same direction shown:
```bash
curl -X POST http://localhost:5000/settlements -H "Content-Type: application/json" -d "{
  \"groupId\":\"<GROUP_ID>\",
  \"fromUserId\":\"<DEBTOR_ID>\",
  \"toUserId\":\"<CREDITOR_ID>\",
  \"amount\":100
}"
```

### Reset data 
```bash
curl -X POST http://localhost:5000/admin/reset
```

## Notes
- Data is stored in-memory (no database). Restarting the server resets all data.
- Amounts are handled in cents internally to reduce rounding issues.

