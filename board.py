# Class to handle the board information
# In order to work with XDAQ, it is necessary to write two files:
# RUCaen.conf where the information are read by the ReadoutUnit
# LocalFilter.conf where the information are read by the LocalFilter

# RUCaen.conf needs the following information:
# Board <board_id> <board_name> <vme_address> <link_type> <link_num> <dpp>
# BoardConf <board_id> <conf_file>

# conf_file is the path to the .json configuration file of the board

# LocalFilter.conf needs the following information:
# Board <board_id> <board_name> <dpp> <chan> <chan_offset> <ns_per_ts> <ns_per_sample>

# dpp should be either "DPP_PHA" or "DPP_PSD"
# chan is the number of channels of the board
# chan_offset is the offset for the channels when LocalFilter is running
# eg. if two boards with 16 channels are running, the first board should have chan_offset = 0 and the second board should have chan_offset = 16
# ns_per_ts is the number of nanoseconds per timestamp (it can be set to 1 so the conversion is made after data are saved and acquired)
# ns_per_sample is the number of nanoseconds per sample (it can be set to 1 so the conversion is made after data are saved and acquired)

class board:
    def __init__(self, id, name, vme, link_type, link_num, dpp, chan, chan_offset=0, ns_per_ts=1, ns_per_sample=1):
        self.board_id = id
        self.board_name = name
        self.vme_address = vme
        self.link_type = link_type
        self.link_num = link_num
        self.conf = "/home/xdaq/project/conf/{}_{}.json".format(self.board_name, self.board_id)
        self.dpp = dpp
        self.chan = chan
        self.chan_offset = chan_offset
        self.ns_per_ts = ns_per_ts
        self.ns_per_sample = ns_per_sample

    def set_board_id(self, board_id):
        self.board_id = board_id

    def set_board_name(self, board_name):
        self.board_name = board_name

    def set_vme_address(self, vme_address):
        self.vme_address = vme_address

    def set_link_type(self, link_type):
        self.link_type = link_type

    def set_link_num(self, link_num):
        self.link_num = link_num

    def set_conf_file(self, conf):
        self.conf = conf

    def set_dpp(self, dpp):
        self.dpp = dpp

    def set_chan(self, chan):
        self.chan = chan

    def set_ns_per_ts(self, ns_per_ts):
        self.ns_per_ts = ns_per_ts

    def set_ns_per_sample(self, ns_per_sample):
        self.ns_per_sample = ns_per_sample

    def get_board_id(self):
        return self.board_id
    
    def get_board_name(self):
        return self.board_name
    
    def get_vme_address(self):
        return self.vme_address
    
    def get_link_type(self):
        return self.link_type
    
    def get_link_num(self):
        return self.link_num
    
    def get_conf_file(self):
        return self.conf
    
    def get_dpp(self):
        return self.dpp
    
    def get_chan(self):
        return self.chan
    
    def get_ns_per_ts(self):
        return self.ns_per_ts
    
    def get_ns_per_sample(self):
        return self.ns_per_sample
    
    def __rustr__(self):
        return "Board\t{}\t{}\t{}\t{}\t{}\t{}\n".format(self.board_name, self.board_id, self.vme_address, self.link_type, self.link_num, self.board_id)

    def __rustrconf__(self):
        return "BoardConf\t{}\t{}\n".format(self.board_id, self.conf)
    
    def __lfstr__(self):
        return "Board\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n".format(self.board_id, self.board_name, self.dpp, self.chan, self.chan_offsetm, self.ns_per_ts, self.ns_per_sample)
