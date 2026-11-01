import { permanentRedirect } from 'next/navigation';

/** The dashboards list is the home page now; old links still land there. */
export default function DashboardsPage() {
  permanentRedirect('/');
}
