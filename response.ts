import { WebrtcSignaling } from './parse'
import WebSocket = require('ws')

interface ResponseError {
  type: 'error'
  reason: string
}

export const error = (reason: string): ResponseError => ({
  type: 'error',
  reason,
})

interface ResponseGameCreated {
  type: 'gameCreated'
  gameId: string
}

export const gameCreated = (gameId: string): ResponseGameCreated => ({
  type: 'gameCreated',
  gameId,
})

interface ResponseGameList {
  type: 'gameList'
  games: Array<{
    gameId: string
    serverName: string
    playerAmount: number
    maxPlayers: number
  }>
}

export const gameList = (
  games: Array<{
    gameId: string
    serverName: string
    playerAmount: number
    maxPlayers: number
    requiresPassword: boolean
  }>
): ResponseGameList => ({
  type: 'gameList',
  games,
})

interface ResponseNewClient {
  type: 'newClient'
  gameId: string
  clientId: string
  password: string | null
}

export const newClient = (
  gameId: string,
  clientId: string,
  password: string | null
): ResponseNewClient => ({
  type: 'newClient',
  gameId,
  clientId,
  password,
})

interface ResponseAcceptJoin {
  type: 'acceptJoin'
  gameId: string
}

export const acceptJoin = (gameId: string): ResponseAcceptJoin => ({
  type: 'acceptJoin',
  gameId,
})

interface ResponseRejectJoin {
  type: 'rejectJoin'
  gameId: string
  reason: string
}

export const rejectJoin = (
  gameId: string,
  reason: string
): ResponseRejectJoin => ({
  type: 'rejectJoin',
  gameId,
  reason,
})

interface ResponseWebrtcSignalingForClient {
  type: 'webrtcSignaling'
  gameId: string
  description?: unknown
  candidate?: unknown
}

export const webrtcSignalingForClient = (
  gameId: string,
  message: WebrtcSignaling
): ResponseWebrtcSignalingForClient => ({
  type: 'webrtcSignaling',
  gameId,
  description: message.description,
  candidate: message.candidate,
})

interface ResponseRtcSignalingForHost {
  type: 'webrtcSignaling'
  gameId: string
  clientId: string
  description?: unknown
  candidate?: unknown
}

export const webrtcSignalingForHost = (
  gameId: string,
  clientId: string,
  message: WebrtcSignaling
): ResponseRtcSignalingForHost => ({
  type: 'webrtcSignaling',
  gameId,
  clientId,
  description: message.description,
  candidate: message.candidate,
})

interface ResponseClientVanished {
  type: 'clientVanished'
  gameId: string
  clientId: string
}

export const clientVanished = (
  gameId: string,
  clientId: string
): ResponseClientVanished => ({
  type: 'clientVanished',
  gameId,
  clientId,
})

type Response =
  | ResponseError
  | ResponseGameCreated
  | ResponseGameList
  | ResponseNewClient
  | ResponseAcceptJoin
  | ResponseRejectJoin
  | ResponseWebrtcSignalingForClient
  | ResponseRtcSignalingForHost
  | ResponseClientVanished

export const send = (ws: WebSocket, response: Response): void => {
  ws.send(JSON.stringify(response))
}
