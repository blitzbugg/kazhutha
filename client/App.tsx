/**
 * Phase 3 app shell — screen routing off the server's redacted view (D42):
 *   no room      → Home (create / join / rejoin)
 *   not-started  → Lobby (waiting room)
 *   in-round     → Table
 *   game-over    → GameOver
 * A reconnecting banner (U5) and toast stack overlay every screen.
 */
import { useEffect, useReducer } from 'react';
import { ConnectionBanner } from './components/ConnectionBanner';
import { GameOver } from './components/GameOver';
import { Home } from './components/Home';
import { Lobby } from './components/Lobby';
import { Table } from './components/Table';
import { Toasts } from './components/Toasts';
import { initSocket } from './socket';
import { initialState, reducer } from './state';

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => initSocket(dispatch), []);

  // Auto-dismiss the oldest toast.
  useEffect(() => {
    const first = state.toasts[0];
    if (first === undefined) return;
    const timer = setTimeout(() => dispatch({ type: 'dismissToast', id: first.id }), 4200);
    return () => clearTimeout(timer);
  }, [state.toasts]);

  let screen;
  if (state.roomCode === null || state.view === null) {
    screen = <Home state={state} dispatch={dispatch} />;
  } else if (state.view.phase === 'not-started') {
    screen = <Lobby state={state} dispatch={dispatch} />;
  } else if (state.view.phase === 'game-over') {
    screen = <GameOver state={state} />;
  } else {
    screen = <Table state={state} />;
  }

  return (
    <div className="app">
      <ConnectionBanner connection={state.connection} />
      {screen}
      <Toasts toasts={state.toasts} />
    </div>
  );
}
