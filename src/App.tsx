import { Routes, Route, Navigate } from 'react-router-dom'
import { RequireAuth } from './components/RequireAuth'
import SignIn from './pages/SignIn'
import Dossier from './pages/Dossier'

export default function App() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignIn />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Dossier />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
