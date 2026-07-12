import { useEffect, useState } from "react";
import { Nav } from "./components/layout/Nav";
import { useAppStore, useFeatures } from "./store/appStore";
import { fetchConfig } from "./api/client";
import type { AppConfig } from "./types";
import { AskGenieBanner } from "./components/genie/AskGenieBanner";
import { OverviewPage } from "./pages/OverviewPage";
import { AccessPage } from "./pages/AccessPage";
import { WorkspacesPage } from "./pages/WorkspacesPage";
import { QueryAdvisorPage } from "./pages/QueryAdvisorPage";
import { TablesPage } from "./pages/TablesPage";
import { GovernancePage } from "./pages/GovernancePage";
import { TagsPage } from "./pages/TagsPage";
import { AdoptionPage } from "./pages/AdoptionPage";
import { RecommendationsPage } from "./pages/RecommendationsPage";
import { GeniePage } from "./pages/GeniePage";
import { AiPage } from "./pages/AiPage";
import { AppsPage } from "./pages/AppsPage";
import { DqmPage } from "./pages/DqmPage";
import { ConfigPage } from "./pages/ConfigPage";

function App() {
  const { activePage, setActivePage, setCurrencies, setFeatures } = useAppStore();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const features = useFeatures();

  useEffect(() => {
    fetchConfig()
      .then((c) => {
        setConfig(c);
        if (c.currencies?.length) setCurrencies(c.currencies);
        if (c.features) setFeatures(c.features);
      })
      .catch(() => setConfig(null));
  }, [setCurrencies, setFeatures]);

  // Guard: if DQM is off but the active page is the DQM tab (e.g. after a flag
  // flip), fall back to Overview so no gated page can render.
  useEffect(() => {
    if (!features.dqm && activePage === "dqm") setActivePage("overview");
  }, [features.dqm, activePage, setActivePage]);

  const currencies = useAppStore((s) => s.currencies);

  return (
    <div className="min-h-full bg-surface text-brand-dark">
      <Nav currencies={currencies} viewer={config?.viewer} />
      {features.genie && <AskGenieBanner />}
      <main>
        {activePage === "overview" && <OverviewPage />}
        {activePage === "access" && <AccessPage />}
        {activePage === "workspaces" && <WorkspacesPage />}
        {activePage === "queries" && <QueryAdvisorPage />}
        {activePage === "tables" && <TablesPage />}
        {activePage === "governance" && <GovernancePage />}
        {activePage === "tags" && <TagsPage />}
        {activePage === "adoption" && <AdoptionPage />}
        {activePage === "genie" && <GeniePage />}
        {activePage === "ai" && <AiPage />}
        {activePage === "apps" && <AppsPage />}
        {activePage === "recommendations" && <RecommendationsPage />}
        {activePage === "dqm" && features.dqm && <DqmPage />}
        {activePage === "admin" && <ConfigPage />}
      </main>
    </div>
  );
}

export default App;
