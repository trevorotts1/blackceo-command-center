/** U062 test */
import { describe,it,expect,vi,afterEach,beforeEach } from "vitest";
import { render,screen,cleanup,fireEvent,waitFor } from "@testing-library/react";
global.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
const {m}=vi.hoisted(()=>({m:vi.fn()}));
vi.mock("@/lib/store",()=>({useMissionControl:()=>m()}));
vi.mock("next/navigation",()=>({useRouter:()=>({push:vi.fn()})}));
import { MissionQueue } from "../../src/components/MissionQueue";
function s(o){return {tasks:[],isLoading:false,updateTaskStatus:vi.fn(),addEvent:vi.fn(),selectedDepartment:null,setSelectedDepartment:vi.fn(),...o}}
beforeEach(()=>{m.mockReturnValue(s())});
afterEach(()=>{cleanup();vi.restoreAllMocks()});
describe("U062",()=>{
it("loading:skeletons,no No tasks",()=>{m.mockReturnValue(s({isLoading:true}));const {container}=render(<MissionQueue departmentFilter={null}/>);["backlog","todo","in_progress","review","blocked","done"].forEach(c=>expect(screen.getByTestId("column-skeleton-"+c)).toBeTruthy());expect(container.innerHTML).not.toContain("No tasks")});
it("empty:generic No tasks",()=>{m.mockReturnValue(s({isLoading:false}));render(<MissionQueue departmentFilter={null}/>);expect(screen.getAllByText("No tasks").length).toBe(6)});
it("empty dept:dept message",()=>{m.mockReturnValue(s({isLoading:false}));render(<MissionQueue departmentFilter="sales"/>);expect(screen.getAllByText("No tasks in this department").length).toBe(6)});
it("filter:mismatch+clear",()=>{const t=[{id:"t1",title:"T",status:"backlog",workspace_id:"w",description:"",created_at:"2026-01-01"}];m.mockReturnValue(s({isLoading:false,tasks:t}));render(<MissionQueue departmentFilter={null}/>);fireEvent.change(screen.getByPlaceholderText("Search tasks..."),{target:{value:"xxx"}});expect(screen.getAllByText("No tasks match this filter").length).toBe(6);expect(screen.getAllByText("Clear filter").length).toBe(6)});
it("error:ErrorState+retry",()=>{m.mockReturnValue(s({isLoading:false}));const r=vi.fn();render(<MissionQueue departmentFilter={null} loadError="F" onRetry={r}/>);expect(screen.getByText("Something went wrong loading this view.")).toBeTruthy();fireEvent.click(screen.getByText("Retry"));expect(r).toHaveBeenCalledTimes(1)});
it("bug:ErrorState on fail",async()=>{vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new Error("x")));m.mockReturnValue(s({isLoading:false}));render(<MissionQueue boardKind="bug"/>);await waitFor(()=>{expect(screen.getByText("Something went wrong loading this view.")).toBeTruthy()},{timeout:5000});expect(screen.getByText("Retry")).toBeTruthy()});
it("four states:4 different",()=>{m.mockReturnValue(s({isLoading:true}));const {container:c1,unmount:u1}=render(<MissionQueue departmentFilter={null}/>);const h1=c1.innerHTML;u1();cleanup();m.mockReturnValue(s({isLoading:false}));const {container:c2,unmount:u2}=render(<MissionQueue departmentFilter={null}/>);const h2=c2.innerHTML;u2();cleanup();const t=[{id:"t1",title:"T",status:"backlog",workspace_id:"w",description:"",created_at:"2026-01-01"}];m.mockReturnValue(s({isLoading:false,tasks:t}));const {container:c3,unmount:u3}=render(<MissionQueue departmentFilter={null}/>);fireEvent.change(screen.getByPlaceholderText("Search tasks..."),{target:{value:"n"}});const h3=c3.innerHTML;u3();cleanup();m.mockReturnValue(s({isLoading:false}));const {container:c4,unmount:u4}=render(<MissionQueue departmentFilter={null} loadError="E" onRetry={()=>{}}/>);const h4=c4.innerHTML;u4();cleanup();expect(new Set([h1,h2,h3,h4]).size).toBe(4);expect(h1).not.toContain("No tasks")});
});
