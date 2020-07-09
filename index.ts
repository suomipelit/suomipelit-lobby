import * as Either from 'fp-ts/lib/Either'
import { pipe } from 'fp-ts/lib/pipeable'
import * as O from 'optics-ts'
import * as t from 'io-ts'
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

const createGame = (
  id: string,
  host: WebSocket,
  games: Game[]
): Either.Either<string, { game: Game; games: Game[] }> => {
  const existing = getGameById(id, games)
  if (existing) return Either.left('Game with this id already exists')
  const game = { id: id, host, clients: [] }
  return Either.right({ game, games: [...games, game] })
}

const joinGame = (
  gameId: string,
  player: WebSocket,
  games: Game[]
): Either.Either<string, { game: Game; client: Client; games: Game[] }> => {
  const game = getGameById(gameId, games)
  if (!game) return Either.left('No such game')
  if (getGameClient(player, game)) Either.left('Already joining this game')

  // TODO: Generate unique client id
  const client = { id: 'foo', ws: player }
  return Either.right({
    game,
    client,
    games: O.set(
      O.optic<Game[]>()
        .find(g => g.id === gameId)
        .prop('clients')
        .appendTo()
    )(client)(games),
  })
}

const CreateGameRequest = t.strict({
  type: t.literal('createGame'),
  gameId: t.string,
})

const JoinGameRequest = t.strict({
  type: t.literal('joinGame'),
  gameId: t.string,
})

const WebrtcSignalingRequest = t.intersection([
  t.strict({
    type: t.literal('webrtcSignaling'),
  }),
  t.partial({
    clientId: t.string,
    description: t.unknown,
    candidate: t.unknown,
  }),
])

type WebrtcSignalingRequest = t.TypeOf<typeof WebrtcSignalingRequest>

const Request = t.union([
  CreateGameRequest,
  JoinGameRequest,
  WebrtcSignalingRequest,
])

type Request = t.TypeOf<typeof Request>

const parseRequest = (data: WebSocket.Data): Request | undefined => {
  if (typeof data !== 'string') return undefined
  return pipe(
    Either.parseJSON(data, Either.toError),
    Either.chainW(Request.decode),
    Either.getOrElseW(() => undefined)
  )
}

const sendResponse = (ws: WebSocket, response: Response): void => {
  ws.send(JSON.stringify(response))
}

const closeWithError = (ws: WebSocket, reason: string): void => {
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

interface ResponseWebrtcSignalingForClient {
  type: 'webrtcSignaling'
  gameId: string
  description?: unknown
  candidate?: unknown
}

const responseWebrtcSignalingForClient = (
  gameId: string,
  request: WebrtcSignalingRequest
): ResponseWebrtcSignalingForClient => ({
  type: 'webrtcSignaling',
  gameId,
  description: request.description,
  candidate: request.candidate,
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
  request: WebrtcSignalingRequest
): ResponseRtcSignalingForHost => ({
  type: 'webrtcSignaling',
  gameId,
  clientId,
  description: request.description,
  candidate: request.candidate,
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
  | ResponseWebrtcSignalingForClient
  | ResponseRtcSignalingForHost
  | ResponseClientVanished

let games: Game[] = []

const handleRequest = (ws: WebSocket, request: Request): void => {
  switch (request.type) {
    case 'createGame': {
      const next = createGame(request.gameId, ws, games)
      if (Either.isRight(next)) {
        games = next.right.games
        sendResponse(ws, responseGameCreated(request.gameId))
      } else {
        closeWithError(ws, next.left)
      }
      break
    }
    case 'joinGame': {
      const next = joinGame(request.gameId, ws, games)
      if (Either.isRight(next)) {
        games = next.right.games
        const { game, client } = next.right
        sendResponse(game.host, responseNewClient(game.id, client.id))
      }
      break
    }
    case 'webrtcSignaling': {
      if (request.clientId !== undefined) {
        // WebRTC signaling from host -> send to client
        const result = getClientById(ws, request.clientId, games)
        if (!result) return
        const { game, client } = result
        sendResponse(
          client.ws,
          responseWebrtcSignalingForClient(game.id, request)
        )
      } else {
        // ICE candidate from client -> send to host
        const game = getGameByClient(ws, games)
        if (!game) return
        const client = getGameClient(ws, game)
        if (!client) return
        sendResponse(
          game.host,
          responseWebrtcSignalingForHost(game.id, client.id, request)
        )
      }
      break
    }
    // TODO: request to join rejected (game full, game already started, etc.)
  }
}

const handleConnectionClose = (ws: WebSocket): void => {
  let game = getGameByHost(ws, games)
  if (game) {
    // Host has closed, notify all clients
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

//////////

let port: number = parseInt(process.env.PORT || '', 10)
if (isNaN(port)) port = 3000

const server = new WebSocket.Server({ port })

server.on('listening', () => {
  console.log(`Listening on port ${port}`)
})

server.on('connection', ws => {
  ws.on('message', data => {
    const request = parseRequest(data)
    if (request === undefined) {
      sendResponse(ws, responseError('Invalid request'))
    } else {
      handleRequest(ws, request)
    }
  })
  ws.on('close', () => {
    handleConnectionClose(ws)
  })
  ws.on('error', () => {
    ws.close()
  })
})
