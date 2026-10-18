import { useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { BootScreen } from './components/BootScreen';
import { AppPage } from './features/app/AppPage';
import { bootstrapAuth, useAuthStore } from './features/auth/auth-store';
import { AuthPage } from './pages/AuthPage';
import { DownloadPage } from './pages/DownloadPage';
import { HomePage } from './pages/HomePage';
import { InvitePage } from './pages/InvitePage';
import { LabP2pPage } from './pages/LabP2pPage';
import { LabVoicePage } from './pages/LabVoicePage';
import { MeetingPage } from './pages/MeetingPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { StreamReportsPage } from './pages/StreamReportsPage';
import { VoiceReportsPage } from './pages/VoiceReportsPage';

/** Sends anonymous visitors to the login page, remembering where they were going. */
function RequireAuth({ children }: { children: ReactNode }) {
  const status = useAuthStore((state) => state.status);
  const location = useLocation();

  if (status === 'loading') {
    return (
      <BootScreen
        steps={[
          { name: 'SESSÃO', state: 'VERIFICANDO', done: false },
          { name: 'GATEWAY', state: 'AGUARDANDO', done: false },
        ]}
      />
    );
  }
  if (status === 'anonymous') {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return children;
}

export function App() {
  useEffect(() => {
    void bootstrapAuth();
  }, []);

  const app = (
    <RequireAuth>
      <AppPage />
    </RequireAuth>
  );

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/app" replace />} />
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route path="/reset/:token" element={<ResetPasswordPage />} />
      <Route path="/download" element={<DownloadPage />} />
      <Route
        path="/invite/:code"
        element={
          <RequireAuth>
            <InvitePage />
          </RequireAuth>
        }
      />
      <Route
        path="/transmissoes/:reportId?"
        element={
          <RequireAuth>
            <StreamReportsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/vozes/:reportId?"
        element={
          <RequireAuth>
            <VoiceReportsPage />
          </RequireAuth>
        }
      />
      {/* Meetings: anyone with the link, signed in or not. */}
      <Route path="/reuniao/:meetingId" element={<MeetingPage />} />
      <Route path="/app" element={app} />
      <Route path="/app/:guildId" element={app} />
      <Route path="/app/:guildId/:channelId" element={app} />

      {/* Lab: the media stack in isolation, without accounts. */}
      <Route path="/lab" element={<HomePage />} />
      <Route path="/lab/p2p" element={<LabP2pPage />} />
      <Route path="/lab/voice" element={<LabVoicePage />} />
      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}
