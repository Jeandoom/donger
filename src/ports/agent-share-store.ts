export interface AgentShare {
  agentId: string;
  token: string;
  enabled: boolean;
  createdAt: string;
}

export interface AgentShareGrant {
  agentId: string;
  userId: string;
  grantedAt: string;
}

export interface ShareRef {
  agentId: string;
  enabled: boolean;
}

export interface AgentShareStore {
  getShare(agentId: string): Promise<AgentShare | undefined>;
  enableShare(agentId: string): Promise<AgentShare>;
  disableShare(agentId: string): Promise<void>;
  listGrants(agentId: string): Promise<AgentShareGrant[]>;
  addGrant(agentId: string, userId: string): Promise<void>;
  removeGrant(agentId: string, userId: string): Promise<void>;
  isGranted(agentId: string, userId: string): Promise<boolean>;
  findByToken(token: string): Promise<ShareRef | undefined>;
}
