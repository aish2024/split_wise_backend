# Expense Sharing Backend (Zero Dependencies)

This project is built to match the assignment requirements:
- Create groups, add shared expenses, track balances (who owes whom), settle dues
- Split types: **equal**, **exact**, **percentage**
- Balances are **simplified** (netted) per group

✅ **No `npm install` needed** (uses only Node.js built-in modules).

## Requirements
- Node.js 18+ (you have Node 24.x, so you're good)

## Run (Windows / Mac / Linux)
### Option 1 (recommended)
```bash
node server.js
```

### Option 2
```bash
npm start
```
(`npm start` works without installing anything because there are no dependencies.)

Server runs on: `http://localhost:5000`

## Quick endpoints
- `GET /health`
- `GET /` (mini docs)

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
#### Equal split
```bash
curl -X POST http://localhost:5000/expenses -H "Content-Type: application/json" -d "{
  \"groupId\":\"<GROUP_ID>\",
  \"paidBy\":\"<ALICE_ID>\",
  \"amount\":1200,
  \"description\":\"Dinner\",
  \"split\":{\"type\":\"equal\"}
}"
```

#### Exact split
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

#### Percentage split
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

### View simplified balances (who owes whom)
```bash
curl http://localhost:5000/groups/<GROUP_ID>/balances
```

### View a user's summary in the group
```bash
curl "http://localhost:5000/users/<ALICE_ID>/summary?groupId=<GROUP_ID>"
```

### Settle dues
First check balances, then settle exactly that direction:
```bash
curl -X POST http://localhost:5000/settlements -H "Content-Type: application/json" -d "{
  \"groupId\":\"<GROUP_ID>\",
  \"fromUserId\":\"<DEBTOR_ID>\",
  \"toUserId\":\"<CREDITOR_ID>\",
  \"amount\":100
}"
```

### Reset everything (for demo/testing)
```bash
curl -X POST http://localhost:5000/admin/reset
```

## Notes
- Data is stored in-memory (no DB). Restarting the server resets data.
- All amounts are handled in **cents** internally to avoid rounding issues.
