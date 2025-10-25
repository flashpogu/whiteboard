// pages/api/socket.ts
import type { NextApiRequest } from 'next'
import type { Server as HTTPServer } from 'http'
import type { Socket as NetSocket } from 'net'
import type { Server as IOServer } from 'socket.io'
import { Server } from 'socket.io'

type NextApiResponseServerIO = {
  socket: NetSocket & {
    server: HTTPServer & { io?: IOServer }
  }
}

export const config = { api: { bodyParser: false } }

type NPoint = { nx:number; ny:number; t:number }
type Stroke = { id:string; points:NPoint[]; color:string; size:number; owner?:string }
type RoomState = { strokes: Stroke[] }

const rooms = new Map<string, RoomState>()

export default function handler(req: NextApiRequest, res: NextApiResponseServerIO) {
  if (!res.socket.server.io) {
    const io = new Server(res.socket.server, {
      path: "/api/socket",
      addTrailingSlash: false,
      cors: { origin: "*", methods: ["GET", "POST"] }
    })

    io.on("connection", (socket) => {
      let roomId: string | null = null

      socket.on("join_room", ({ room }) => {
        roomId = room
        socket.join(room)
        const state = rooms.get(room) || { strokes: [] }
        rooms.set(room, state)
        // send full state to this client
        socket.emit("state", state)
        socket.to(room).emit("user_joined", { id: socket.id })
      })

      socket.on("cursor", (payload) => {
        if (!roomId) return
        socket.to(roomId).emit("cursor", { id: socket.id, ...payload })
      })

      socket.on("stroke_start", ({ room, stroke }) => {
        roomId = room
        socket.join(room)
        const state = rooms.get(room) || { strokes: [] }
        rooms.set(room, state)
        state.strokes.push({ ...stroke })
        socket.to(room).emit("stroke_start", { id: socket.id, stroke })
      })

      socket.on("stroke_append", ({ room, point }) => {
        if (!roomId) return
        const state = rooms.get(roomId); if (!state) return
        const last = state.strokes[state.strokes.length - 1]
        if (last) last.points.push(point)
        socket.to(roomId).emit("stroke_append", { id: socket.id, point })
      })

      socket.on("stroke_end", ({ room }) => {
        if (!roomId) return
        socket.to(roomId).emit("stroke_end", { id: socket.id })
      })

      socket.on("clear", ({ room }) => {
        if (!roomId) return
        const state = rooms.get(roomId); if (state) state.strokes = []
        io.to(roomId).emit("clear")
      })

      socket.on("undo", ({ room }) => {
        if (!roomId) return
        const state = rooms.get(roomId); if (!state) return
        state.strokes.pop()
        io.to(roomId).emit("undo")
      })

      socket.on("disconnect", () => {
        if (roomId) socket.to(roomId).emit("user_left", { id: socket.id })
      })
    })

    res.socket.server.io = io
  }
  res.end()
}
