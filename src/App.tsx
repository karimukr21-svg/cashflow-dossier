import { Routes, Route, Navigate } from 'react-router-dom'
import { RequireAuth } from './components/RequireAuth'
import { WorkspaceShell } from './modules/WorkspaceShell'
import SignIn from './pages/SignIn'
import Dossier from './pages/Dossier'
import AnalyzeShell from './pages/analyze/AnalyzeShell'

export default function App() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignIn />} />
      {/* Treasury Workspace shell wraps every module. RequireAuth sits outside
          so RoleContext reaches the switcher and access is checked once. */}
      <Route
        element={
          <RequireAuth>
            <WorkspaceShell />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Dossier />} />
        <Route path="/analyze" element={<AnalyzeShell />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
