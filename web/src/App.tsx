import { Button } from "./components/ui/button";

export function App() {
  return (
    <div className="p-6">
      <Button onClick={() => console.log("ok")}>样式自检</Button>
    </div>
  );
}
