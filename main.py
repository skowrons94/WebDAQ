import os
import sys
import time
import docker

from TopologyManager import TopologyManager

client = docker.from_env()

# If container xdaq exists, remove it
try:
    #client.containers.get("xdaq").stop()
    client.containers.get("xdaq").remove(force=True)
except docker.errors.NotFound:
    pass

# Get current directory
dir = os.path.dirname(os.path.realpath(__file__))

# Run container xdaq
client.containers.run( "skowrons/xdaq:v3.0", "sleep infinity", 
                       hostname="xdaq", 
                       name="xdaq", 
                       ports={'50000': 50000, '51000': 51000, '52000': 52000,
                              '40000': 40000, '41000': 41000, '42000': 42000},
                       volumes={dir: {'bind': '/home/xdaq/project', 'mode': 'rw'},
                                '/dev': {'bind': '/dev', 'mode': 'rw'}, 
                                '/lib/modules': {'bind': '/lib/modules', 'mode': 'rw'}},
                       detach=True, 
                       remove=True, 
                       privileged=True )

# Start ReadoutUnit in the container
cmd = "/opt/xdaq/bin/xdaq.exe -p 50000 -c /home/xdaq/project/conf/topology.xml"
client.containers.get("xdaq").exec_run(cmd, detach=True, tty=True, stdin=True, stdout=True, stderr=True)

# Start LocalFilter in the container
cmd = "/opt/xdaq/bin/xdaq.exe -p 51000 -c /home/xdaq/project/conf/topology.xml"
client.containers.get("xdaq").exec_run(cmd, detach=True, tty=True, stdin=True, stdout=True, stderr=True)

# Start BuilderUnit in the container
cmd = "/opt/xdaq/bin/xdaq.exe -p 52000 -c /home/xdaq/project/conf/topology.xml"
client.containers.get("xdaq").exec_run(cmd, detach=True, tty=True, stdin=True, stdout=True, stderr=True)

# Sleep for 2 seconds
time.sleep(2)

# Read the topology
tm = TopologyManager( "conf/topology.xml" )
tm.load_topology( )

# Display the topology
tm.display()

# Configure the TCP/IP links
tm.configure_pt( )
tm.enable_pt( )
tm.start()