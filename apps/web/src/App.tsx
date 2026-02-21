import { useEffect, useState } from "react";

export default function App() {
  const [status, setStatus] = useState("Loading...");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => setStatus(d.status))
      .catch(() => setStatus("API fetch failed"));
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-black text-blue-500 text-5xl font-bold">
      {status} 🚀
    </div>
  );
}
