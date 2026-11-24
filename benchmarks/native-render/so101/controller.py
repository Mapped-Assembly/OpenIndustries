"""SO-101 task adapted from isayahc/trace-unseen at ff16236ed126293755909d11aa315d747c65a0d5.

MuJoCo owns joint/object motion; this demo stops after the first verified placement.
"""
from pathlib import Path
import json
import xml.etree.ElementTree as ET
import numpy as np
import mujoco as mj

ASSETS = Path(__file__).resolve().parent / "cache"

def build() -> mj.MjModel:
    """Build the sourced SO-101 workcell with explicitly assumed contact pads."""
    tree = ET.parse(ASSETS/'so101.xml')
    root = tree.getroot()
    root.find('compiler').set('meshdir', str(ASSETS/'assets'))
    ET.SubElement(root,'option',timestep='.002',integrator='implicitfast',iterations='80')
    world = root.find('worldbody')
    # Table top defines Z=0; SO101 stays at its native scale and base frame.
    ET.SubElement(world,'geom',name='workbench',type='box',pos='0 0 -.025',size='.55 .45 .025',rgba='.18 .23 .27 1')
    for x in [-.48,.48]:
        for y in [-.38,.38]:
            ET.SubElement(world,'geom',name=f'leg{x}{y}',type='cylinder',pos=f'{x} {y} -.35',size='.018 .3',rgba='.4 .45 .5 1')
    ET.SubElement(world,'geom',name='floor',type='plane',pos='0 0 -.65',size='2 2 .1',rgba='.07 .1 .13 1')
    # Thin receiving trays have real floors and walls; cylinders are actual cans.
    for name,x,y,color in [('accept',.16,-.14,'.1 .5 .4 1'),('reject',.16,.14,'.65 .2 .12 1')]:
        ET.SubElement(world,'geom',name=name+'-tray',type='box',pos=f'{x} {y} .005',size='.065 .065 .005',rgba=color)
        for dx,dy,sx,sy in [(-.065,0,.003,.065),(.065,0,.003,.065),(0,-.065,.065,.003),(0,.065,.065,.003)]:
            ET.SubElement(world,'geom',name=f'{name}-wall-{dx}-{dy}',type='box',pos=f'{x+dx} {y+dy} .02',size=f'{sx} {sy} .015',rgba=color)
    for i,(x,y) in enumerate([(.24,-.045),(.24,0),(.24,.045)]):
        body=ET.SubElement(world,'body',name=f'can{i}',pos=f'{x} {y} .041')
        ET.SubElement(body,'freejoint',name=f'can{i}')
        ET.SubElement(body,'geom',name=f'can{i}',type='cylinder',size='.018 .03',mass='.014',friction='1.3 .02 .002',condim='6',rgba=('.95 .25 .13 1' if i==1 else '.45 .8 .85 1'))
        # Individual presentation pucks hold cans within the reachable pickup zone.
        ET.SubElement(world,'geom',name=f'feed-puck{i}',type='cylinder',pos=f'{x} {y} .005',size='.025 .005',rgba='.15 .2 .23 1')
    ET.SubElement(world,'geom',name='camera-post',type='cylinder',pos='.40 .25 .19',size='.008 .19',rgba='.4 .45 .5 1',contype='0',conaffinity='0')
    ET.SubElement(world,'geom',name='camera-arm',type='capsule',fromto='.40 .25 .38 .24 0 .38',size='.008',rgba='.4 .45 .5 1',contype='0',conaffinity='0')
    ET.SubElement(world,'geom',name='inspection-camera',type='box',pos='.24 0 .38',size='.025 .035 .018',rgba='.08 .09 .1 1',contype='0',conaffinity='0')
    ET.SubElement(world,'geom',name='camera-lens',type='cylinder',pos='.24 0 .355',size='.013 .008',rgba='.15 .4 .6 1',contype='0',conaffinity='0')
    grip = root.find('.//body[@name="gripper"]')
    ET.SubElement(grip,'site',name='pickup',pos='.012 -.0002 -.08',size='.003',rgba='0 1 0 1')
    root.find('.//actuator/position[@name="gripper"]').set('forcerange','-.3 .3')
    # Convexifying the entire concave jaw fills its grasp opening. Keep the original
    # visual mesh, but use measured finger-pad proxies for usable contact surfaces.
    for mesh in ['wrist_roll_follower_so101_v1','moving_jaw_so101_v1']:
        for g in root.findall(f'.//geom[@mesh="{mesh}"]'):
            if g.get('class')=='collision': g.set('contype','0');g.set('conaffinity','0')
    ET.SubElement(grip,'geom',name='fixed-pad',type='box',pos='-.012 -.0002 -.08',size='.004 .009 .02',friction='3 .02 .002',condim='6',solref='.004 1',rgba='.08 .08 .08 1')
    jaw=root.find('.//body[@name="moving_jaw_so101_v1"]')
    ET.SubElement(jaw,'geom',name='moving-pad',type='box',pos='-.0082 -.0566 .0188',size='.004 .02 .009',friction='3 .02 .002',condim='6',solref='.004 1',rgba='.08 .08 .08 1')
    # Collision mesh parts are convex hulls in MuJoCo, while detailed GLBs are used visually.
    for g in root.findall('.//geom[@class="collision"]'):
        g.set('friction','1.5 .02 .002')
        g.set('condim','6')
    for g in world.findall('.//geom'):
        if 'name' not in g.attrib:
            g.set('name',f'part-{len([x for x in root.findall(".//geom") if "name" in x.attrib])}')
    return mj.MjModel.from_xml_string(ET.tostring(root,encoding='unicode'))

class Cell:
    """Closed-loop scripted task; only MuJoCo advances object and joint state."""

    def __init__(self) -> None:
        """Initialize the model and a collision-free pre-task arm configuration."""
        self.m = build()
        self.d = mj.MjData(self.m)
        self.ikdata = mj.MjData(self.m)
        self.phase='ready'
        self.running=False
        self.index=0
        self.accepted=0
        self.rejected=0
        self.error=None
        self.events=[]
        self.phase_time=0
        self.target=None
        self.site=self.m.site('pickup').id
        self.qstart=np.array([0,-1,1,0,0,.8])
        self.d.qpos[:6]=self.qstart
        self.d.ctrl[:6]=self.qstart
        mj.mj_forward(self.m,self.d)
        self.d.qpos[:5]=self.ik([.20,0,.10])
        self.d.ctrl[:5]=self.d.qpos[:5]
        mj.mj_forward(self.m,self.d)

    def ik(self, position: list[float] | np.ndarray) -> np.ndarray:
        """Solve a reachable downward-facing TCP target with damped Jacobian IK."""
        d=self.ikdata
        best=None
        for seed in [self.d.qpos[:5],np.array([0,-.5,1,.8,0]),np.zeros(5)]:
            d.qpos[:]=self.d.qpos
            d.qpos[:5]=seed
            for _ in range(200):
                mj.mj_forward(self.m,d)
                rot=d.site_xmat[self.site].reshape(3,3)
                # Align gripper local +Z with world +Z: fingers point down.
                axis_error=np.cross(rot[:,2],np.array([0,0,1]))
                error=np.r_[np.array(position)-d.site_xpos[self.site], axis_error[:2]*.15]
                if np.linalg.norm(error)<.0005: break
                jp,jr=np.zeros((3,self.m.nv)),np.zeros((3,self.m.nv))
                mj.mj_jacSite(self.m,d,jp,jr,self.site)
                jac=np.vstack([jp[:,:5],jr[:2,:5]*.15])
                dq=jac.T@np.linalg.solve(jac@jac.T+np.eye(5)*1e-5,error)
                d.qpos[:5]=np.clip(d.qpos[:5]+np.clip(dq,-.12,.12),self.m.jnt_range[:5,0]+.01,self.m.jnt_range[:5,1]-.01)
            dist=np.linalg.norm(d.site_xpos[self.site]-position)
            if best is None or dist<best[0]: best=(dist,d.qpos[:5].copy())
        if best[0]>.008: raise RuntimeError(f'IK unreachable target {position}: {best[0]:.3f}m')
        return best[1]

    def goto(self, phase: str, position: list[float] | np.ndarray | None = None, grip: float | None = None) -> None:
        """Set actuator goals and record a task phase transition."""
        self.phase=phase
        self.phase_time=self.d.time
        if position is not None: self.target=self.ik(position)
        if grip is not None: self.d.ctrl[5]=grip
        self.events.append({'time':round(self.d.time,3),'phase':phase,'can':self.index})

    def command(self, command: str) -> None:
        """Start, pause or reset the scripted pick-and-place task."""
        if command=='start':
            if self.phase=='ready': self.goto('approach',self.d.body('can0').xpos+np.array([0,0,.06]),.8)
            if self.phase not in ['complete','fault']: self.running=True
        elif command=='pause': self.running=False
        elif command=='reset': self.__init__()

    def contact(self, can: int, other: str) -> bool:
        """Check actual MuJoCo contact pairs, not commanded grasp state."""
        a,b=self.m.geom(f'can{can}').id,self.m.geom(other).id
        return any({c.geom1,c.geom2}=={a,b} for c in self.d.contact)

    def placed(self, i: int) -> bool:
        """Require tray contact, containment and settled velocity."""
        p=self.d.body(f'can{i}').xpos
        adr=self.m.joint(f'can{i}').dofadr[0]
        y=.14 if i==1 else -.14
        return (self.contact(i,('reject' if i==1 else 'accept')+'-tray')
                and abs(p[0]-.16)<.05 and abs(p[1]-y)<.05
                and np.linalg.norm(self.d.qvel[adr:adr+6])<.03)

    def tick(self) -> None:
        """Advance actuator goals and one physics step; gate transitions on observations."""
        if not self.running: return
        try:
            if self.target is not None:
                self.d.ctrl[:5]+=np.clip(self.target-self.d.ctrl[:5],-.002,.002)
            mj.mj_step(self.m,self.d)
            if sum(w.number for w in self.d.warning) or not np.isfinite(self.d.qpos).all(): raise RuntimeError('MuJoCo instability')
            elapsed=self.d.time-self.phase_time
            reached=self.target is None or np.max(np.abs(self.target-self.d.qpos[:5]))<.025
            p=self.d.body(f'can{min(self.index,2)}').xpos.copy()
            dest=np.array([.16,.14,.05]) if self.index==1 else np.array([.14,-.115,.05])
            if self.index==2: dest=np.array([.185,-.165,.05])
            if elapsed>15: raise RuntimeError(f'{self.phase} timeout')
            if self.phase=='approach' and reached and elapsed>1:
                self.goto('inspect',p+np.array([0,0,.06]))
            elif self.phase=='inspect' and elapsed>.5:
                self.goto('descend',p,.8)
            elif self.phase=='descend' and reached and elapsed>.5:
                self.goto('grasp',grip=-.1)
            elif self.phase=='grasp' and elapsed>1.5:
                if not self.contact(self.index,'fixed-pad') or not self.contact(self.index,'moving-pad'):
                    raise RuntimeError('Grasp failed: bilateral finger contact absent')
                self.goto('lift',p+np.array([0,0,.04]))
            elif self.phase=='lift' and reached and elapsed>1:
                if p[2]<.065: raise RuntimeError('Grasp failed: can did not lift with the fingers')
                self.goto('transfer',dest+np.array([0,0,.035]))
            elif self.phase=='transfer' and reached and elapsed>1:
                self.goto('place',dest)
            elif self.phase=='place' and reached and elapsed>1:
                self.goto('release',grip=.8)
            elif self.phase=='release' and elapsed>1:
                self.goto('retreat',dest+np.array([0,0,.035]))
            elif self.phase=='retreat' and reached and elapsed>1:
                self.goto('verify')
            elif self.phase=='verify' and elapsed>.6:
                if not all(self.placed(i) for i in range(self.index+1)):
                    if elapsed<5:return
                    raise RuntimeError('Placement failed: tray contact, containment or settling check')
                if self.index==1: self.rejected+=1
                else: self.accepted+=1
                self.index+=1
                if self.index==1:
                    self.goto('complete');self.running=False
                else: self.goto('approach',self.d.body(f'can{self.index}').xpos+np.array([0,0,.06]),.8)
        except Exception as exc:
            self.error=str(exc);self.phase='fault';self.running=False
