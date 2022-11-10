import * as Either from 'fp-ts/lib/Either'
import * as t from 'io-ts'
import { pipe } from 'fp-ts/lib/pipeable'
import WebSocket = require('ws')

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

export type WebrtcSignaling = t.TypeOf<typeof WebrtcSignaling>

const IncomingMessage = t.union([
  t.intersection([
    t.strict({
      type: t.literal('createGame'),
      serverName: t.string,
      maxPlayers: t.number,
    }),
    t.partial({
      gameId: t.string,
      requiresPassword: t.boolean,
    }),
  ]),

  t.intersection([
    t.strict({
      type: t.literal('updateGameInfo'),
      serverName: t.string,
      playerAmount: t.number,
      maxPlayers: t.number,
    }),
    t.partial({
      requiresPassword: t.boolean,
    }),
  ]),

  t.strict({
    type: t.literal('listGames'),
  }),

  t.intersection([
    t.strict({
      type: t.literal('joinGame'),
      gameId: t.string,
    }),
    t.partial({
      password: t.string,
    }),
  ]),

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

export type IncomingMessage = t.TypeOf<typeof IncomingMessage>

export const parseIncomingMessage = (
  data: WebSocket.Data
): IncomingMessage | undefined => {
  if (typeof data !== 'string') return undefined
  return pipe(
    Either.parseJSON(data, Either.toError),
    Either.chainW((v) => IncomingMessage.decode(v)),
    Either.getOrElseW(() => undefined)
  )
}
