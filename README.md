# Demogorgon Radar

A real-time multiplayer **social hunt** game (Among-Us style) in a **50m x 50m** room.

## Gameplay implemented

- Real-time lobby (Socket.IO), host controls start/reset.
- Secret role assignment:
  - 1 Demogorgon (impostor-like)
  - Remaining players are Security.
- Live radar showing player positions in a 50m indoor coordinate plane.
- During the run phase:
  - Security receives proximity alerts when Demogorgon is near.
  - Demogorgon can eliminate nearby Security with cooldown.
  - Any alive player can call one emergency meeting.
- Meeting phase:
  - Alive players vote to eject a suspect or skip.
  - Votes resolve automatically on timer or when all alive players vote.
- End conditions:
  - Demogorgon wins when all Security are eliminated.
  - Security wins if Demogorgon is ejected or correctly identified.

## Positioning modes

1. **GPS mode** (browser geolocation)
   - Converts movement from first GPS lock into local 50m map offsets.
2. **Simulation mode**
   - Manual sliders for indoor testing.

For higher indoor accuracy, feed server with X/Y from BLE/UWB positioning (native app or hardware client).

## Run

```bash
npm install
npm start
```

Open `http://localhost:3000` on the host machine.

## Use on other devices (same Wi-Fi)

1. Start server on your laptop/host.
2. In terminal, copy one LAN URL printed by server (for example `http://192.168.1.23:3000`).
3. Open that exact LAN URL on phones/tablets connected to the same Wi-Fi.
4. If it still fails, allow inbound TCP `3000` in your firewall.

You can verify server reachability from another device by opening:

`http://<HOST_LAN_IP>:3000/health`
