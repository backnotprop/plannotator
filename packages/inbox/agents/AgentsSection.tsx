import { useMemo, type MouseEvent, type ReactNode } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { useInboxAgents } from '../agentsList';
import { Icon } from '../icons';
import { awayLine, isAway, machineNotice, type MachinesModel } from '../machines';
import type { MachineView } from '../api';
import { MachineSidebarWord } from '../components/MachineUpdate';
import { Tip } from '../components/Tip';
import { AgentMark } from './AgentMark';
import { agentFacts, agentHostName, agentsGroups, type AgentEntry } from './model';

/**
 * The sidebar's Agents section (approval "inbox-agents-section", APPROVED STATE 2026-11-09), in place of Machines:
 * an inset rounded panel, its heading "Agents" with the Plannotator goggles in the heading grey and two buttons always
 * shown, + (Add agent) and laptop-plus (Add machine). Under it each machine's agents: the machine's name a small quiet
 * grey caption flush left (still the machine's filter, as its Machines row was), its agents a small step in, each a
 * 24 px animated mark (motion.ts) and its name. No counts and no state marks; no lines; roomier gaps between machines.
 * No machine linked: one flat list. A click on an agent opens its thread; its hover card says where and when it
 * started, and its project.
 *
 * Its data is the list's `agents` (agentsList.ts): drawing the section is what makes the window read the list again
 * on `event: deliveries` with `agents`.
 */
export interface AgentsSectionProps {
  machines: MachinesModel;
  /** The rows the window has (every section), where an agent's thread is found. */
  rows: readonly InboxListRow[];
  /** The machine the list shows (a caption's filter), or null. */
  machineId: string | null;
  /** The thread on screen: its agent's row carries the selection fill. */
  openThreadId: string | null;
  page: string;
  closed: boolean;
  onToggle: () => void;
  labelId: string;
  bodyId: string;
  /** The section header (shared with Pinned and Projects), drawn with the goggles. */
  header: (icon: ReactNode) => ReactNode;
  onMachine?: (machineId: string) => void;
  onMachineUpdate?: (machineId: string) => void;
  onOpenThread: (threadId: string) => void;
  /** A live agent with no thread in the window: New message to it. */
  onMessageAgent: (session: string, opener: HTMLElement) => void;
  /** Add agent: New message with a new session chosen. */
  onAddAgent: (opener: HTMLElement) => void;
  /** Add machine: Settings → Machines, where a machine is linked. Absent on an Inbox that cannot link. */
  onAddMachine?: () => void;
  /** Wraps a navigation (closes the phone sheet first). */
  pick: (go: () => void) => () => void;
}

/** The Plannotator goggles, one shape in the current colour (the heading's grey), for both themes. */
export function GogglesMark() {
  return (
    <svg className="ib-ic ib-agents-mk" viewBox="142 141.6 740 740" aria-hidden="true" focusable="false">
      <g transform="scale(0.5)">
        <path
          fillRule="evenodd"
          d="M 461.500 645.113 C 436.478 649.592, 417.750 659.979, 401.870 678.187 C 392.425 689.016, 386.988 698.355, 376.825 721.200 C 371.858 732.365, 367.607 741.696, 367.377 741.936 C 367.148 742.176, 355.607 742.540, 341.730 742.744 C 327.854 742.948, 315.953 743.294, 315.285 743.513 C 314.339 743.822, 314.070 776.948, 314.070 893.205 C 314.070 975.317, 314.337 1048.237, 314.663 1055.250 L 315.257 1068 340.043 1068 L 364.829 1068 367.535 1072.750 C 370.464 1077.893, 374.259 1084.781, 379.792 1095 C 381.727 1098.575, 386.771 1107.800, 391 1115.500 C 395.229 1123.200, 400.410 1132.650, 402.513 1136.500 C 419.585 1167.750, 439.947 1183.468, 471.753 1189.950 L 481.920 1192.022 660.210 1191.761 L 838.500 1191.500 845.485 1188.588 C 854.975 1184.630, 861.990 1179.983, 868.577 1173.290 C 877.485 1164.239, 878.420 1162.443, 908.028 1097.500 C 909.533 1094.200, 912.447 1087.900, 914.504 1083.500 C 916.561 1079.100, 919.948 1071.675, 922.031 1067 C 924.115 1062.325, 930.177 1049.050, 935.503 1037.500 C 940.829 1025.950, 949.920 1006.150, 955.706 993.500 C 961.492 980.850, 969.954 962.810, 974.511 953.411 C 981.725 938.533, 983.354 935.913, 987.101 933.157 C 992.992 928.824, 999.821 926.459, 1010.705 924.979 C 1032.082 922.074, 1054.302 926.456, 1063.172 935.326 C 1065.991 938.145, 1073.557 952.451, 1080.451 968 C 1082.036 971.575, 1085.018 978.100, 1087.076 982.500 C 1093.343 995.892, 1110.592 1033.183, 1112.979 1038.500 C 1116.248 1045.781, 1119.351 1052.595, 1122.885 1060.250 C 1127.966 1071.260, 1131.441 1078.830, 1137 1091 C 1142.559 1103.170, 1146.034 1110.740, 1151.115 1121.750 C 1152.829 1125.463, 1155.367 1130.975, 1156.755 1134 C 1169.164 1161.043, 1172.294 1166.212, 1181.630 1175.070 C 1191.477 1184.414, 1201.177 1189.063, 1214.894 1191.015 C 1220.184 1191.767, 1275.945 1192.006, 1398 1191.798 L 1573.500 1191.500 1583.372 1188.777 C 1608.167 1181.936, 1626.751 1168.286, 1640.245 1147 C 1642.163 1143.975, 1651.833 1126.650, 1661.734 1108.500 C 1671.635 1090.350, 1680.740 1073.813, 1681.967 1071.750 L 1684.198 1068 1709.099 1068 L 1734 1068 1734 905.500 L 1734 743 1721.750 742.996 C 1715.013 742.994, 1703.817 742.702, 1696.871 742.348 L 1684.242 741.704 1678.910 730.626 C 1670.844 713.871, 1662.305 698.297, 1656.909 690.500 C 1641.638 668.435, 1621.682 653.930, 1597.372 647.223 L 1587.500 644.500 1027 644.359 C 700.922 644.277, 464.409 644.593, 461.500 645.113 M 485.500 702.029 C 465.531 703.058, 453.769 706.569, 446.584 713.644 C 443.761 716.425, 435.040 733.653, 423.627 759 L 417.998 771.500 417.999 908.741 L 418 1045.982 427.360 1062.241 C 432.508 1071.183, 440.207 1085.025, 444.470 1093 C 455.682 1113.975, 458.507 1118.371, 463.875 1123.198 C 469.643 1128.384, 477.960 1131.506, 490 1133.005 C 495.754 1133.721, 551.646 1133.972, 663 1133.782 L 827.500 1133.500 831.008 1126.500 C 832.937 1122.650, 835.834 1116.575, 837.444 1113 C 839.055 1109.425, 842.036 1102.900, 844.070 1098.500 C 846.103 1094.100, 850.117 1085.325, 852.989 1079 C 855.861 1072.675, 860.413 1062.833, 863.105 1057.129 C 865.797 1051.425, 868 1046.629, 868 1046.472 C 868 1046.314, 869.963 1041.981, 872.363 1036.842 C 876.499 1027.986, 877.694 1025.367, 883.013 1013.500 C 884.246 1010.750, 888.286 1001.975, 891.991 994 C 903.144 969.995, 904.992 966.002, 910.735 953.500 C 913.767 946.900, 919.342 935.026, 923.124 927.113 C 926.906 919.200, 930 912.548, 930 912.331 C 930 912.113, 932.019 908.871, 934.486 905.126 C 945.231 888.816, 964.222 876.210, 987.043 870.238 L 997.500 867.502 1021 867.600 C 1045.595 867.702, 1054.839 868.751, 1067.745 872.904 C 1085.253 878.538, 1102.450 890.438, 1110.406 902.424 C 1115.940 910.761, 1129.668 938.876, 1148.774 981 C 1152.641 989.525, 1157.377 999.875, 1159.299 1004 C 1161.221 1008.125, 1163.965 1014.087, 1165.396 1017.250 C 1169.330 1025.936, 1172.819 1033.516, 1177.639 1043.842 C 1180.038 1048.981, 1182 1053.334, 1182 1053.515 C 1182 1053.697, 1184.250 1058.640, 1187 1064.500 C 1189.750 1070.360, 1192 1075.310, 1192 1075.500 C 1192 1075.690, 1194.168 1080.493, 1196.818 1086.173 C 1199.468 1091.853, 1202.956 1099.402, 1204.568 1102.950 C 1206.181 1106.497, 1210.006 1114.822, 1213.068 1121.450 L 1218.636 1133.500 1393.923 1133.753 L 1569.210 1134.006 1575.355 1130.753 C 1586.698 1124.748, 1589.176 1121.286, 1611.320 1080.500 C 1618.188 1067.850, 1626.100 1053.450, 1628.901 1048.500 L 1633.995 1039.500 1633.998 905.872 L 1634 772.244 1632.396 768.405 C 1630.389 763.602, 1615.451 733.717, 1610.700 725 C 1604.445 713.524, 1597.919 708.482, 1584.500 704.757 C 1579.002 703.230, 1572.245 702.633, 1553 701.972 C 1523.324 700.952, 505.339 701.007, 485.500 702.029"
        />
      </g>
      <rect x="286" y="400" width="119.99" height="110.99" />
      <rect x="639.01" y="400.01" width="120.98" height="110.98" />
      <rect x="432.04" y="672.06" width="175.93" height="28.93" />
    </svg>
  );
}

/** Lucide's laptop with a plus on its screen, drawn like the window's other icons (24-unit grid, current colour). */
function LaptopPlus() {
  return (
    <svg className="ib-ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-icon="laptopPlus">
      <path d="M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM2 20h20M12 7.5v5M9.5 10h5" />
    </svg>
  );
}

function AgentTip({ entry, machine }: { entry: AgentEntry; machine: MachineView | null }) {
  const facts = agentFacts(entry, machine);
  return (
    <span className="ib-agtip" data-agent-tip="">
      <bdi className="ib-agtip-t">{facts.title}</bdi>
      <span className="ib-agtip-s">{facts.sub}</span>
      <span className="ib-agtip-st">{facts.state}</span>
      {facts.rows.length > 0 && (
        <span className="ib-agtip-dl">
          {facts.rows.map(([key, value]) => (
            <span key={key} className="ib-agtip-r">
              <span className="ib-agtip-k">{key}</span>
              <bdi className="ib-agtip-v">{value}</bdi>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

export function AgentsSection(props: AgentsSectionProps) {
  const groupsRead = useInboxAgents();
  const groups = useMemo(() => agentsGroups(groupsRead, props.machines, props.rows), [groupsRead, props.machines, props.rows]);
  const flat = groups.length === 1 && groups[0]!.machine === null;
  const empty = groups.every((group) => group.agents.length === 0) && flat;
  const machineOn = (id: string) => props.page === 'inbox' && props.machineId === id;
  const agentOn = (entry: AgentEntry) => props.page === 'inbox' && !!entry.thread && props.openThreadId === entry.thread.id;
  // A launch not yet joined by its agent has no session to write to, only its thread.
  const canMessage = (entry: AgentEntry) => entry.agent.live && !entry.agent.session.startsWith('launch:');
  const open = (entry: AgentEntry, event: MouseEvent<HTMLButtonElement>) => {
    const opener = event.currentTarget;
    if (entry.thread) return props.pick(() => props.onOpenThread(entry.thread!.id))();
    if (canMessage(entry)) return props.pick(() => props.onMessageAgent(entry.agent.session, opener))();
  };
  return (
    <div className="ib-sbagents" data-agents-surface="">
      <div className="ib-secrow" data-agents-head="" data-one-add={props.onAddMachine ? undefined : ""}>
        {props.header(<GogglesMark />)}
        <Tip content="Add agent">
          <button type="button" className="ib-proj-sort ib-agents-add" aria-label="Add agent" aria-haspopup="dialog" data-agents-add="agent" onClick={(event) => props.pick(() => props.onAddAgent(event.currentTarget))()}>
            <Icon name="plus" />
          </button>
        </Tip>
        {props.onAddMachine && (
          <Tip content="Add machine">
            <button type="button" className="ib-proj-sort ib-agents-add" aria-label="Add machine" data-agents-add="machine" onClick={props.pick(() => props.onAddMachine?.())}>
              <LaptopPlus />
            </button>
          </Tip>
        )}
      </div>
      <div className="ib-agents-body" id={props.bodyId} role="group" aria-labelledby={props.labelId} data-agents-section="" data-flat={flat ? '' : undefined} data-closed={props.closed ? '' : undefined}>
        {empty && !props.closed && <div className="ib-side-empty ib-agents-empty">Agents show here while they run.</div>}
        {groups.map((group) => {
          const machine = group.machine;
          const rows = group.agents.filter((entry) => !props.closed || agentOn(entry));
          const captionOn = !!machine && machineOn(machine.id);
          if (props.closed && rows.length === 0 && !captionOn) return null;
          const away = machine ? isAway(machine) : false;
          const notice = machine && props.onMachineUpdate ? machineNotice(machine) : null;
          return (
            <div key={machine?.id ?? 'flat'} className="ib-agents-group" data-agents-machine={machine?.id ?? ''}>
              {machine && (
                <div className="ib-mside ib-agents-cap" data-machine-notice={notice?.kind ?? undefined}>
                  <Tip content={machine.self ? 'This machine' : (awayLine(machine) ?? machine.name)} side="right">
                    <button
                      type="button"
                      className={`ib-proj ib-proj-quiet${captionOn ? ' ib-on' : ''}`}
                      onClick={props.pick(() => props.onMachine?.(machine.id))}
                      aria-current={captionOn ? 'page' : undefined}
                      data-machine={machine.id}
                      data-away={away ? '' : undefined}
                    >
                      <span className="ib-name" dir="auto">
                        {machine.name}
                      </span>
                      {away && <span className="ib-sr">, {awayLine(machine)}</span>}
                    </button>
                  </Tip>
                  {notice && <MachineSidebarWord notice={notice} name={machine.name} onPress={props.pick(() => props.onMachineUpdate?.(machine.id))} />}
                </div>
              )}
              {rows.map((entry) => {
                const on = agentOn(entry);
                return (
                  <div key={entry.agent.id} className="ib-sbagent" data-sidebar-agent={entry.agent.id} data-agent-state={entry.agent.state}>
                    <Tip content={<AgentTip entry={entry} machine={machine} />} side="right" align="start">
                      <button
                        type="button"
                        className={`ib-proj${on ? ' ib-on' : ''}${away ? ' ib-proj-quiet' : ''}`}
                        aria-current={on ? 'page' : undefined}
                        onClick={(event) => open(entry, event)}
                        data-agent-open={entry.thread ? 'thread' : canMessage(entry) ? 'message' : 'none'}
                      >
                        <AgentMark id={entry.agent.id} host={entry.agent.host} state={entry.agent.state} />
                        <span className="ib-name" dir="auto">
                          {entry.name}
                        </span>
                        <span className="ib-sr">, {agentHostName(entry.agent.host)}</span>
                      </button>
                    </Tip>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
