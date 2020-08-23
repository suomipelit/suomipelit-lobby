import * as Either from 'fp-ts/lib/Either'
import { pipe } from 'fp-ts/lib/pipeable'
import * as O from 'optics-ts'
import * as t from 'io-ts'
import express = require('express')
import cors = require('cors')
import WebSocket = require('ws')

interface Game {
  id: string
  host: WebSocket
  clients: Client[]
}

interface Client {
  id: string
  ws: WebSocket
}

const getGameById = (id: string, games: Game[]): Game | undefined =>
  games.find(game => game.id === id)

const getGameByHost = (host: WebSocket, games: Game[]): Game | undefined =>
  games.find(game => game.host === host)

const getGameByClient = (ws: WebSocket, games: Game[]): Game | undefined =>
  games.find(game => game.clients.some(client => client.ws === ws))

const getGameClient = (ws: WebSocket, game: Game): Client | undefined =>
  game.clients.find(client => client.ws === ws)

const getClientById = (
  host: WebSocket,
  clientId: string,
  games: Game[]
): { game: Game; client: Client } | undefined => {
  const game = games.find(game => game.host === host)
  if (!game) return undefined

  const client = game.clients.find(client => client.id === clientId)
  if (!client) return undefined

  return { game, client }
}

const removeGame = (gameId: string, games: Game[]): Game[] =>
  games.filter(game => game.id !== gameId)

const removeClient = (
  gameId: string,
  clientId: string,
  games: Game[]
): Game[] =>
  // TODO: Needs the upcoming version of optics-ts:
  // O.remove(
  //   O.optic<Game[]>()
  //     .elems()
  //     .when(game => game.id === gameId)
  //     .prop('clients')
  //     .find(client => client.id === clientId)
  // )(games)
  games.map(game =>
    game.id !== gameId
      ? game
      : {
          ...game,
          clients: game.clients.filter(client => client.id !== clientId),
        }
  )

const randomId = () => Math.random().toString(36).substring(2, 6).toUpperCase()

const createGame = (
  gameId: string | undefined,
  host: WebSocket,
  games: Game[]
): Either.Either<string, { game: Game; games: Game[] }> => {
  let id: string
  if (!gameId) {
    id = randomId()
  } else {
    // TODO: Use io-ts decoder and its parse() combinator to transform
    // to upper case upon decoding
    gameId = gameId.toUpperCase()
    const existing = getGameById(gameId, games)
    if (existing) return Either.left('Game with this id already exists')
    id = gameId
  }
  const game = { id, host, clients: [] }
  return Either.right({ game, games: [...games, game] })
}

const joinGame = (
  gameId: string,
  player: WebSocket,
  games: Game[]
): Either.Either<string, { game: Game; client: Client; games: Game[] }> => {
  const game = getGameById(gameId.toUpperCase(), games)
  if (!game) return Either.left('No such game')
  if (getGameClient(player, game)) Either.left('Already joining this game')

  const client = { id: randomId(), ws: player }
  return Either.right({
    game,
    client,
    games: O.set(
      O.optic<Game[]>()
        .find(g => g.id === game.id)
        .prop('clients')
        .appendTo()
    )(client)(games),
  })
}

const WebrtcSignaling = t.intersection([
  t.strict({
    type: t.literal('webrtcSignaling'),
  }),
  t.partial({
    clientId: t.string,
    description: t.unknown,
    candidate: t.unknown,
  }),
])

type WebrtcSignaling = t.TypeOf<typeof WebrtcSignaling>

const IncomingMessage = t.union([
  t.intersection([
    t.strict({
      type: t.literal('createGame'),
    }),
    t.partial({
      gameId: t.string,
    }),
  ]),

  t.strict({
    type: t.literal('joinGame'),
    gameId: t.string,
  }),

  t.strict({
    type: t.literal('acceptJoin'),
    gameId: t.string,
    clientId: t.string,
  }),

  t.strict({
    type: t.literal('rejectJoin'),
    gameId: t.string,
    clientId: t.string,
    reason: t.string,
  }),

  WebrtcSignaling,
])

type IncomingMessage = t.TypeOf<typeof IncomingMessage>

const parseIncomingMessage = (
  data: WebSocket.Data
): IncomingMessage | undefined => {
  if (typeof data !== 'string') return undefined
  return pipe(
    Either.parseJSON(data, Either.toError),
    Either.chainW(IncomingMessage.decode),
    Either.getOrElseW(() => undefined)
  )
}

const sendResponse = (ws: WebSocket, response: Response): void => {
  ws.send(JSON.stringify(response))
}

const closeWithError = (ws: WebSocket, reason: string): void => {
  console.log('Error:', reason)
  sendResponse(ws, responseError(reason))
  ws.close()
}

interface ResponseError {
  type: 'error'
  reason: string
}

const responseError = (reason: string): ResponseError => ({
  type: 'error',
  reason,
})

interface ResponseGameCreated {
  type: 'gameCreated'
  gameId: string
}

const responseGameCreated = (gameId: string): ResponseGameCreated => ({
  type: 'gameCreated',
  gameId,
})

interface ResponseNewClient {
  type: 'newClient'
  gameId: string
  clientId: string
}

const responseNewClient = (
  gameId: string,
  clientId: string
): ResponseNewClient => ({
  type: 'newClient',
  gameId,
  clientId,
})

interface ResponseAcceptJoin {
  type: 'acceptJoin'
  gameId: string
}

const responseAcceptJoin = (gameId: string): ResponseAcceptJoin => ({
  type: 'acceptJoin',
  gameId,
})

interface ResponseRejectJoin {
  type: 'rejectJoin'
  gameId: string
  reason: string
}

const responseRejectJoin = (
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

const responseWebrtcSignalingForClient = (
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

const responseWebrtcSignalingForHost = (
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

const responseClientVanished = (
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
  | ResponseNewClient
  | ResponseAcceptJoin
  | ResponseRejectJoin
  | ResponseWebrtcSignalingForClient
  | ResponseRtcSignalingForHost
  | ResponseClientVanished

let games: Game[] = []

const handleIncomingMessage = (
  ws: WebSocket,
  message: IncomingMessage
): void => {
  switch (message.type) {
    case 'createGame': {
      const next = createGame(message.gameId, ws, games)
      if (Either.isRight(next)) {
        const { game } = next.right
        console.log(`Created game ${game.id}`)
        games = next.right.games
        sendResponse(ws, responseGameCreated(game.id))
      } else {
        closeWithError(ws, next.left)
      }
      break
    }
    case 'joinGame': {
      const next = joinGame(message.gameId, ws, games)
      if (Either.isRight(next)) {
        games = next.right.games
        const { game, client } = next.right
        sendResponse(game.host, responseNewClient(game.id, client.id))
      } else {
        closeWithError(ws, next.left)
      }
      break
    }
    case 'acceptJoin': {
      const result = getClientById(ws, message.clientId, games)
      if (!result) {
        console.log('No such client:', message.clientId)
        return
      }
      const { client, game } = result
      sendResponse(client.ws, responseAcceptJoin(game.id))
      break
    }
    case 'rejectJoin': {
      const result = getClientById(ws, message.clientId, games)
      if (!result) {
        console.log('No such client:', message.clientId)
        return
      }
      const { client, game } = result
      sendResponse(client.ws, responseRejectJoin(game.id, message.reason))
      break
    }
    case 'webrtcSignaling': {
      if (message.clientId !== undefined) {
        // WebRTC signaling from host -> send to client
        const result = getClientById(ws, message.clientId, games)
        if (!result) {
          console.log('No such client:', message.clientId)
          return
        }
        const { game, client } = result
        sendResponse(
          client.ws,
          responseWebrtcSignalingForClient(game.id, message)
        )
      } else {
        // ICE candidate from client -> send to host
        const game = getGameByClient(ws, games)
        if (!game) {
          console.log('Game not found')
          return
        }
        const client = getGameClient(ws, game)
        if (!client) {
          console.log('Client not found')
          return
        }
        sendResponse(
          game.host,
          responseWebrtcSignalingForHost(game.id, client.id, message)
        )
      }
      break
    }
  }
}

const handleConnectionClose = (ws: WebSocket): void => {
  let game = getGameByHost(ws, games)
  if (game) {
    // Host has closed, notify all clients
    console.log(`Host disconnected, removing game ${game.id}`)
    game.clients.forEach(client => {
      closeWithError(client.ws, 'Host vanished')
    })
    games = removeGame(game.id, games)
    return
  }

  game = getGameByClient(ws, games)
  if (game) {
    // Client has closed, notify the host
    const client = getGameClient(ws, game)
    if (!client) return
    sendResponse(game.host, responseClientVanished(game.id, client.id))
    games = removeClient(game.id, client.id, games)
    return
  }
}

const sendPings = (): void => {
  games.forEach(game => {
    game.host.ping()
    game.clients.forEach(client => client.ws.ping())
  })
}

//////////

let port: number = parseInt(process.env.PORT || '', 10)
if (isNaN(port)) port = 3000

const app = express()
app.use(cors())
app.use((_req, res) => res.send(''))

const server = app.listen(port, () => {
  console.log(`Listening on port ${port}`)
})

const wsServer = new WebSocket.Server({ server })

// Keep connections alive by sending pings to all connected sockets
// every 30 seconds
setInterval(sendPings, 30000)

wsServer.on('connection', ws => {
  ws.on('message', data => {
    const message = parseIncomingMessage(data)
    if (message === undefined) {
      console.log('Invalid message:', data)
      sendResponse(ws, responseError('Invalid message'))
    } else {
      console.log('Processing message:', data)
      handleIncomingMessage(ws, message)
    }
  })
  ws.on('close', () => {
    handleConnectionClose(ws)
  })
  ws.on('error', () => {
    ws.close()
  })
})
