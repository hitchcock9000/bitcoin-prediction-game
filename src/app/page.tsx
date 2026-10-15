import Game from './Game';

/**
 * The page is a thin shell: all of the behaviour lives in the client component,
 * and all of the authority lives on the server.
 */
export default function HomePage() {
  return <Game />;
}
