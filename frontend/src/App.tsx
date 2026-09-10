import { useEffect, useState } from 'react';
import type { MouseEvent } from 'react';
import './App.css';
import { AdminPage } from './pages/AdminPage.tsx';
import { BuyerPage } from './pages/BuyerPage.tsx';

function useLocationPath(): [string, (path: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function navigate(nextPath: string) {
    window.history.pushState(null, '', nextPath);
    setPath(nextPath);
  }

  return [path, navigate];
}

function App() {
  const [path, navigate] = useLocationPath();

  function handleNavClick(
    event: MouseEvent<HTMLAnchorElement>,
    target: string,
  ) {
    event.preventDefault();
    navigate(target);
  }

  return (
    <>
      <nav className="site-nav">
        <a href="/" onClick={(event) => handleNavClick(event, '/')}>
          Sale
        </a>
        <a href="/admin" onClick={(event) => handleNavClick(event, '/admin')}>
          Admin
        </a>
      </nav>
      {path === '/admin' ? <AdminPage /> : <BuyerPage />}
    </>
  );
}

export default App;
