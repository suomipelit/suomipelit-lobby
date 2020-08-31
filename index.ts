import * as Either from 'fp-ts/lib/Either'
import * as O from 'optics-ts'
import express = require('express')
import cors = require('cors')
import WebSocket = require('ws')

import { IncomingMessage, parseIncomingMessage } from './parse'
import * as response from './response'

interface Game {
  id: string
  host: WebSocket
  clients: Client[]
  gameInfo: GameInfo
}

interface GameInfo {
  serverName: string
  playerAmount: number
  maxPlayers: number
  requiresPassword: boolean
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

interface GameOptions {
  serverName: string
  maxPlayers: number
  requiresPassword: boolean
}

const createGame = (
  gameId: string | undefined,
  gameOptions: GameOptions,
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
  const game = {
    id,
    host,
    clients: [],
    gameInfo: {
      serverName: gameOptions.serverName,
      playerAmount: 1,
      maxPlayers: gameOptions.maxPlayers,
      requiresPassword: gameOptions.requiresPassword,
    },
  }
  return Either.right({ game, games: [...games, game] })
}

const updateGameInfo = (host: WebSocket, gameInfo: GameInfo): Game[] =>
  games.map(game => {
    if (game.host === host) {
      return { ...game, gameInfo }
    }
    return game
  })

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

const closeWithError = (ws: WebSocket, reason: string): void => {
  console.log('Error:', reason)
  response.send(ws, response.error(reason))
  ws.close()
}

let games: Game[] = []

const handleIncomingMessage = (
  ws: WebSocket,
  message: IncomingMessage
): void => {
  switch (message.type) {
    case 'createGame': {
      const next = createGame(
        message.gameId,
        {
          serverName: message.serverName,
          maxPlayers: message.maxPlayers,
          requiresPassword: message.requiresPassword ?? false,
        },
        ws,
        games
      )
      if (Either.isRight(next)) {
        const { game } = next.right
        console.log(`Created game ${game.id}`)
        games = next.right.games
        response.send(ws, response.gameCreated(game.id))
      } else {
        closeWithError(ws, next.left)
      }
      break
    }
    case 'updateGameInfo': {
      games = updateGameInfo(ws, {
        serverName: message.serverName,
        playerAmount: message.playerAmount,
        maxPlayers: message.maxPlayers,
        requiresPassword: message.requiresPassword ?? false,
      })
      break
    }
    case 'listGames': {
      response.send(
        ws,
        response.gameList(
          games.map(game => ({
            gameId: game.id,
            serverName: game.gameInfo.serverName,
            playerAmount: game.gameInfo.playerAmount,
            maxPlayers: game.gameInfo.maxPlayers,
          }))
        )
      )
      break
    }
    case 'joinGame': {
      const next = joinGame(message.gameId, ws, games)
      if (Either.isRight(next)) {
        games = next.right.games
        const { game, client } = next.right
        response.send(
          game.host,
          response.newClient(game.id, client.id, message.password ?? null)
        )
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
      response.send(client.ws, response.acceptJoin(game.id))
      break
    }
    case 'rejectJoin': {
      const result = getClientById(ws, message.clientId, games)
      if (!result) {
        console.log('No such client:', message.clientId)
        return
      }
      const { client, game } = result
      response.send(client.ws, response.rejectJoin(game.id, message.reason))
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
        response.send(
          client.ws,
          response.webrtcSignalingForClient(game.id, message)
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
        response.send(
          game.host,
          response.webrtcSignalingForHost(game.id, client.id, message)
        )
      }
      break
    }
    default:
      assertNever(message)
  }
}

function assertNever(x: never): never {
  throw new Error('Unexpected value' + x)
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
    response.send(game.host, response.clientVanished(game.id, client.id))
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
      response.send(ws, response.error('Invalid message'))
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
