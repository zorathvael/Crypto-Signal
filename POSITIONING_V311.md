# v3.11 Positioning Layer

## Status
- `positioning.js` is on `main` (Funding, Open Interest, Long/Short ratio).
- Scanner body is shipped as `scanner.part1.js` + `scanner.part2.js` (assembled at runtime by bootstrap `scanner.js`).

## What it does
Adjusts signal confidence using derivatives positioning:
- Stronger funding extremes (crowding proxy)
- Bitget account long/short ratio
- Open interest presence tag
- Rejects trades when positioning strongly fights the signal (delta <= -8 and conf < SNIPER)

## Local run
```bash
node --check positioning.js
node scanner.js   # assembles parts then runs
```
