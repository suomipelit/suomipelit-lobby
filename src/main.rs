use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::routing::get;
use axum::{Error, Router};
use rand::distributions::{Alphanumeric, DistString};
use rand::thread_rng;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tokio::select;
use tokio::sync::mpsc;

struct GameInfo {
    server_name: String,
    player_amount: u32,
    max_players: u32,
    requires_password: bool,
}

struct Game {
    game_id: GameId,
    host: SocketId,
    clients: HashSet<SocketId>,
    game_info: GameInfo,
}

struct Games(Vec<Game>);

impl Games {
    fn new() -> Self {
        Self(Vec::new())
    }

    fn add(&mut self, game: Game) {
        self.0.push(game);
    }

    fn update_info(&mut self, host: &SocketId, info: GameInfo) -> bool {
        if let Some(game) = self.0.iter_mut().find(|game| game.host == *host) {
            game.game_info = info;
            true
        } else {
            false
        }
    }

    fn join_game(
        &mut self,
        game_id: &GameId,
        client: &SocketId,
    ) -> Result<SocketId, JoinGameError> {
        let game = self
            .0
            .iter_mut()
            .find(|game| game.game_id == *game_id)
            .ok_or(JoinGameError::GameNotFound)?;
        if !game.clients.insert(client.clone()) {
            Err(JoinGameError::AlreadyJoined)
        } else {
            Ok(game.host.clone())
        }
    }

    fn remove_game(&mut self, host: &SocketId) -> bool {
        if let Some(index) = self.0.iter().position(|game| game.host == *host) {
            self.0.remove(index);
            true
        } else {
            false
        }
    }

    fn remove_client(&mut self, client: &SocketId) {
        for game in self.0.iter_mut() {
            game.clients.remove(client);
        }
    }

    fn list(&self) -> Vec<OutgoingGameInfo> {
        self.0
            .iter()
            .map(|game| OutgoingGameInfo {
                game_id: game.game_id.clone(),
                server_name: game.game_info.server_name.clone(),
                player_amount: game.game_info.player_amount,
                max_players: game.game_info.max_players,
                requires_password: game.game_info.requires_password,
            })
            .collect()
    }

    fn get_game_by_host(&self, host: &SocketId) -> Option<&Game> {
        self.0.iter().find(|game| game.host == *host)
    }

    fn get_game_by_client(&self, client: &SocketId) -> Option<&Game> {
        self.0.iter().find(|game| game.clients.contains(client))
    }
}

struct Sockets(HashMap<SocketId, mpsc::Sender<OutgoingMessage>>);

impl Sockets {
    fn new() -> Self {
        Self(HashMap::new())
    }

    fn get(&self, socket_id: &SocketId) -> mpsc::Sender<OutgoingMessage> {
        self.0.get(socket_id).unwrap().clone()
    }

    fn register(&mut self) -> (SocketId, mpsc::Receiver<OutgoingMessage>) {
        let (tx, rx) = mpsc::channel(10);
        let id = SocketId::random();
        self.0.insert(id.clone(), tx);
        (id, rx)
    }

    fn unregister(&mut self, socket_id: &SocketId) {
        self.0.remove(socket_id);
    }
}

#[derive(Clone)]
struct AppState {
    games: Arc<Mutex<Games>>,
    sockets: Arc<Mutex<Sockets>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            games: Arc::new(Mutex::new(Games::new())),
            sockets: Arc::new(Mutex::new(Sockets::new())),
        }
    }

    fn lock_games<T, F>(&self, f: F) -> T
    where
        F: FnOnce(&mut Games) -> T,
    {
        let mut guard = self.games.lock().unwrap();
        f(&mut guard)
    }

    fn lock_sockets<T, F>(&self, f: F) -> T
    where
        F: FnOnce(&mut Sockets) -> T,
    {
        let mut guard = self.sockets.lock().unwrap();
        f(&mut guard)
    }
}

#[derive(Debug)]
enum JoinGameError {
    GameNotFound,
    AlreadyJoined,
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route(
            "/",
            get(
                |ws: WebSocketUpgrade, State(state): State<AppState>| async {
                    ws.on_upgrade(|socket| handle_websocket(socket, state))
                },
            ),
        )
        .with_state(AppState::new());
    axum::Server::bind(&"0.0.0.0:8080".parse().unwrap())
        .serve(app.into_make_service())
        .await
        .unwrap();
}

async fn handle_websocket(socket: WebSocket, app_state: AppState) {
    let (socket_id, rx) = app_state.lock_sockets(|sockets| sockets.register());

    let mut client = SocketState {
        socket_id,
        socket,
        app_state: app_state.clone(),
        rx,
    };
    client.run().await;

    app_state.lock_sockets(|sockets| sockets.unregister(&client.socket_id));
}

struct SocketState {
    socket_id: SocketId,
    socket: WebSocket,
    app_state: AppState,
    rx: mpsc::Receiver<OutgoingMessage>,
}

impl SocketState {
    async fn run(&mut self) {
        loop {
            select! {
                msg = self.socket.recv() => {
                    if !self.handle_message(msg).await {
                        break;
                    }
                },
                Some(outgoing) = self.rx.recv() => {
                    self.send(outgoing).await;
                },
                else => break
            }
        }
    }

    // Returns true if the socket should continue to run
    async fn handle_message(&mut self, message: Option<Result<Message, Error>>) -> bool {
        let Some(message) = message else {
            self.app_state.lock_games(|games| {
                process_disconnect(&self.socket_id, games);
            });
            return false
        };
        let Ok(message) = message else {
            println!("Error receiving websocket message");
            return true
        };
        let Ok(data) = message.to_text() else {
            println!("Received non-text message");
            self.send(OutgoingMessage::Error {
                reason: "Invalid message".to_string(),
            }).await;
            return true
        };
        if data.is_empty() {
            println!("Received empty message from {}", self.socket_id.0);
        } else {
            println!("Received message from {}: {}", self.socket_id.0, data);
            let incoming_message = match serde_json::from_str(data) {
                Ok(incoming) => incoming,
                Err(err) => {
                    println!("Invalid message from socket {}: {}", self.socket_id.0, data);
                    self.send(OutgoingMessage::Error {
                        reason: format!("Invalid message: {}", err),
                    })
                    .await;
                    return true;
                }
            };

            let MessagesToSend {
                self_message,
                other_message,
            } = self.app_state.lock_games(|games| {
                process_incoming_message(&self.socket_id, games, incoming_message)
            });

            if let Some(outgoing) = self_message {
                self.send(outgoing).await;
            };
            if let Some((other_socket_id, outgoing)) = other_message {
                let tx = self
                    .app_state
                    .lock_sockets(|sockets| sockets.get(&other_socket_id));
                tx.send(outgoing).await.unwrap();
            }
        }
        true
    }

    async fn send(&mut self, message: OutgoingMessage) {
        let data = serde_json::to_string(&message).unwrap();
        self.socket.send(data.into()).await.unwrap();
    }
}

struct MessagesToSend {
    self_message: Option<OutgoingMessage>,
    other_message: Option<(SocketId, OutgoingMessage)>,
}

impl MessagesToSend {
    fn self_(message: OutgoingMessage) -> Self {
        Self {
            self_message: Some(message),
            other_message: None,
        }
    }

    fn other(id: SocketId, message: OutgoingMessage) -> Self {
        Self {
            self_message: None,
            other_message: Some((id, message)),
        }
    }

    fn none() -> Self {
        Self {
            self_message: None,
            other_message: None,
        }
    }
}

fn process_incoming_message(
    socket_id: &SocketId,
    games: &mut Games,
    message: IncomingMessage,
) -> MessagesToSend {
    match message {
        IncomingMessage::WebrtcSignaling {
            client_id: target_socket_id,
            description,
            candidate,
        } => {
            if let Some(target_socket_id) = target_socket_id {
                // WebRTC signaling from host -> send to client
                if let Some(game) = games.get_game_by_host(socket_id) {
                    MessagesToSend::other(
                        target_socket_id,
                        OutgoingMessage::WebrtcSignaling {
                            game_id: game.game_id.clone(),
                            client_id: None,
                            description,
                            candidate,
                        },
                    )
                } else {
                    MessagesToSend::none()
                }
            } else if let Some(game) = games.get_game_by_client(socket_id) {
                // WebRTC signaling from client -> send to host
                MessagesToSend::other(
                    game.host.clone(),
                    OutgoingMessage::WebrtcSignaling {
                        game_id: game.game_id.clone(),
                        client_id: Some(socket_id.clone()),
                        description,
                        candidate,
                    },
                )
            } else {
                MessagesToSend::none()
            }
        }
        IncomingMessage::CreateGame {
            game_id,
            server_name,
            max_players,
            requires_password,
        } => {
            let game_id = game_id.unwrap_or_else(GameId::random);
            games.add(Game {
                game_id: game_id.clone(),
                host: socket_id.clone(),
                clients: HashSet::new(),
                game_info: GameInfo {
                    server_name,
                    player_amount: 1,
                    max_players,
                    requires_password: requires_password.unwrap_or(false),
                },
            });
            MessagesToSend::self_(OutgoingMessage::GameCreated { game_id })
        }
        IncomingMessage::UpdateGameInfo {
            max_players,
            player_amount,
            server_name,
            requires_password,
        } => {
            if games.update_info(
                socket_id,
                GameInfo {
                    max_players,
                    player_amount,
                    server_name,
                    requires_password: requires_password.unwrap_or(false),
                },
            ) {
                MessagesToSend::none()
            } else {
                MessagesToSend::self_(OutgoingMessage::Error {
                    reason: "You're not a game host".to_string(),
                })
            }
        }
        IncomingMessage::ListGames => MessagesToSend::self_(OutgoingMessage::GameList {
            games: games.list(),
        }),
        IncomingMessage::JoinGame { game_id, password } => {
            match games.join_game(&game_id, socket_id) {
                Err(err) => MessagesToSend::self_(OutgoingMessage::Error {
                    // TODO: format for JoinGameError
                    reason: format!("{:?}", err),
                }),
                Ok(host) => MessagesToSend::other(
                    host,
                    OutgoingMessage::NewClient {
                        game_id,
                        client_id: socket_id.clone(),
                        password,
                    },
                ),
            }
        }
        IncomingMessage::AcceptJoin {
            game_id,
            client_id: accepted_socket_id,
        } => MessagesToSend::other(accepted_socket_id, OutgoingMessage::AcceptJoin { game_id }),
        IncomingMessage::RejectJoin {
            game_id,
            client_id: rejected_socket_id,
            reason,
        } => {
            games.remove_client(&rejected_socket_id);
            MessagesToSend::other(
                rejected_socket_id,
                OutgoingMessage::RejectJoin { game_id, reason },
            )
        }
    }
}

fn process_disconnect(socket_id: &SocketId, games: &mut Games) {
    if games.remove_game(socket_id) {
        return;
    }
    games.remove_client(socket_id);
}

fn random_string() -> String {
    Alphanumeric.sample_string(&mut thread_rng(), 16)
}

#[derive(Debug, PartialEq, Eq, Clone, Hash, Serialize, Deserialize)]
struct SocketId(String);

impl SocketId {
    fn random() -> Self {
        Self(random_string())
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Hash, Serialize, Deserialize)]
struct GameId(String); // String for backwards compat

impl GameId {
    fn random() -> Self {
        Self(random_string())
    }
}
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum IncomingMessage {
    #[serde(rename_all = "camelCase")]
    WebrtcSignaling {
        client_id: Option<SocketId>,
        description: Option<serde_json::Value>,
        candidate: Option<serde_json::Value>,
    },
    #[serde(rename_all = "camelCase")]
    CreateGame {
        server_name: String,
        max_players: u32,
        game_id: Option<GameId>,
        requires_password: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    UpdateGameInfo {
        server_name: String,
        player_amount: u32,
        max_players: u32,
        requires_password: Option<bool>,
    },
    ListGames,
    #[serde(rename_all = "camelCase")]
    JoinGame {
        game_id: GameId,
        password: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    AcceptJoin {
        game_id: GameId,
        client_id: SocketId,
    },
    #[serde(rename_all = "camelCase")]
    RejectJoin {
        game_id: GameId,
        client_id: SocketId,
        reason: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum OutgoingMessage {
    #[serde(rename_all = "camelCase")]
    Error { reason: String },

    #[serde(rename_all = "camelCase")]
    WebrtcSignaling {
        game_id: GameId,
        client_id: Option<SocketId>,
        description: Option<serde_json::Value>,
        candidate: Option<serde_json::Value>,
    },

    #[serde(rename_all = "camelCase")]
    GameCreated { game_id: GameId },

    #[serde(rename_all = "camelCase")]
    GameList { games: Vec<OutgoingGameInfo> },

    #[serde(rename_all = "camelCase")]
    NewClient {
        game_id: GameId,
        client_id: SocketId,
        password: Option<String>,
    },

    #[serde(rename_all = "camelCase")]
    AcceptJoin { game_id: GameId },

    #[serde(rename_all = "camelCase")]
    RejectJoin { game_id: GameId, reason: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutgoingGameInfo {
    game_id: GameId,
    server_name: String,
    player_amount: u32,
    max_players: u32,
    requires_password: bool,
}
